import os from "node:os";
import { LruMap } from "../core/lru.js";
import type { SessionState, YavioConfig } from "../core/types.js";
import { HttpTransport } from "../transport/http.js";
import type { Transport } from "../transport/types.js";

/**
 * Process-level state behind every wrapped server (#133).
 *
 * A stateless host builds a new McpServer — and so wraps a new one — for
 * every request. Everything that must survive across those wraps lives here,
 * keyed by the resolved `(endpoint, apiKey)`, so a conversation spread over
 * many per-request server instances looks like one long-lived server to
 * ingest:
 *
 * - one `HttpTransport` (one flush timer, one batch stream) per key;
 * - one `sessions` map per key: `yavio.identify()`, the traits and the step
 *   sequence of a conversation, found again by the next instance that serves
 *   the same `Mcp-Session-Id` or `openai/session`;
 * - exactly one SIGTERM/SIGINT handler pair for the whole process, which
 *   drains every transport in the registry and then hands the signal back:
 *   the listeners are removed and, if nothing else listens, the signal is
 *   re-raised so Node's default exit runs (#138).
 *
 * Not shared, on purpose: the widget token. Ingest binds a widget JWT to the
 * trace id of the call that minted it (`WIDGET_TRACE_ID_MISMATCH` for any
 * other), and every tool call has its own trace id, so a token is minted per
 * call and never cached.
 *
 * Still per wrapped instance (in createProxy): the connection's own session,
 * the current MCP transport, the set of tools the instance wrapped. Module
 * level elsewhere, keyed by API key: the connection-event dedup
 * (`emittedConnections`) and the discovery dedup (`emittedToolDiscoveries`)
 * in proxy.ts.
 *
 * Lifetime. The transport of a key is held by every `createYavio()` client
 * bound to it (a counter) and pinned by the first `withYavio()` call for it
 * (which has no shutdown of its own). `client.shutdown()` drains and
 * releases that client's hold; the transport stops only when the last hold
 * is gone and nothing pins it — another client's events for the same key
 * keep flowing. The signal handlers drain everything regardless. The key's
 * state object outlives its transports: proxies keep it, and a re-acquire
 * after a stop puts a fresh transport behind the same facade.
 *
 * Shutdown from a signal handler (#142). The SDK's listener is prepended,
 * so it runs first and drains the registry; the app's handler then calls
 * `client.shutdown()`, whose hold the signal already cleared. Every release
 * therefore awaits the process-level `signalDrain` first, and a stale hold
 * then drains the key's current transport — the immediate one a request
 * finishing after the signal sent through — instead of returning. So
 * `shutdown()` resolves only once everything queued before it reached
 * ingest, and `process.exit()` after the await exits with nothing in
 * flight. The one order this does not cover is the documented #140
 * exception: an app listener added with `prependOnceListener` after the
 * SDK installed its own runs before ours and is gone when we count, so the
 * SDK takes itself for the only listener and re-raises after the drain.
 */

export interface SharedSessions {
  /**
   * Sessions by their derived id, for servers that serve many conversations
   * (stateless transports, OpenAI's per-call reconnects). Bounded; the least
   * recently used goes first, and its eviction hook drops the connection-event
   * mark so the conversation's next call, which starts a fresh state, emits
   * a fresh connection event.
   */
  sessions: LruMap<string, SessionState>;
}

export interface SharedState extends SharedSessions {
  /**
   * The transport to ingest, stable for the key's lifetime: a facade over
   * whichever `HttpTransport` is live for the key right now. A proxy keeps
   * the facade, so a wrap after the last holder's `shutdown()` — which
   * returns the existing proxy — sends through the fresh transport the
   * re-acquire started, not the stopped one.
   */
  transport: Transport;
}

export const MAX_SESSIONS = 1000;

/**
 * Fresh session state with no transport attached. The proxy's default when it
 * is built directly (tests); the registry builds the real one.
 */
export function createSharedSessions(onEvict?: (sessionId: string) => void): SharedSessions {
  return {
    sessions: new LruMap<string, SessionState>(MAX_SESSIONS, (sessionId) => onEvict?.(sessionId)),
  };
}

/**
 * The key's state, kept for the process lifetime (one per distinct config,
 * never deleted): the sessions and the transport facade every proxy of the
 * key holds. `live` is the HttpTransport behind the facade — replaced when
 * the key is re-acquired after its transport stopped.
 */
interface Slot extends SharedState {
  live: Transport | null;
}

/** A live transport: holders, pin, and a generation that tells it from its successors. */
interface Entry {
  slot: Slot;
  /** Live `createYavio()` clients bound to this key. */
  holders: number;
  /** Set by `withYavio()`, which never releases: the state lives until a signal. */
  pinned: boolean;
  /** Distinct per transport: a hold on a cleared or stopped one must not release the next. */
  generation: number;
}

/** A hold on a key's live transport, released by `releaseShared(config, hold)`. */
export interface SharedHold {
  state: SharedState;
  generation: number;
}

const slots = new Map<string, Slot>();
const registry = new Map<string, Entry>();
let generations = 0;

/**
 * What the registry needs of a config: the key, and the drain deadline. The
 * first client or `withYavio()` call to create a key's transport sets the
 * transport's own deadline, which the SDK's signal drain uses; a
 * `client.shutdown()` passes its own config's deadline into every release,
 * drain and transport shutdown it causes, so a client always gets the
 * deadline it configured (#142 review).
 */
type Key = Pick<YavioConfig, "endpoint" | "apiKey"> &
  Partial<Pick<YavioConfig, "shutdownTimeoutMs">>;

const keyOf = (config: Key): string => `${config.endpoint}\n${config.apiKey}`;

/**
 * Set by the signal handler, never cleared (outside tests): the process is
 * on its way out. A transport created from now on sends on every `send()`
 * — no timer will fire for it and no shutdown will drain it — so events
 * from requests still served during the graceful-shutdown window go out
 * best effort, bounded by the fetch timeout and the buffer cap.
 */
let draining = false;

/**
 * The signal handler's drain, running or done — accumulated when a signal is
 * handled again after a hand-back. Awaited by every `releaseShared` and
 * `settleShared`, so an app handler's `client.shutdown()` waits for the
 * drain the SDK's listener started a tick earlier (#142). Cleared with the
 * rest of the state only in tests: a process that got a signal stays on
 * its way out.
 */
let signalDrain: Promise<void> | null = null;

function noteDraining(): void {
  logOnce("draining", () =>
    console.info(
      "[yavio] Shutdown signal received — events from requests served from now on are sent at once, best effort.",
    ),
  );
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type HandledSignal = (typeof SIGNALS)[number];

/** The SDK's listener per signal, bound to its name — `process.emit("SIGINT")` without an argument is common in harnesses. */
let signalListeners: Map<HandledSignal, () => void> | null = null;
/**
 * The signal being handled, with whether the SDK was the only listener when
 * it arrived. A second signal while this is set means "stop waiting".
 */
let signalInFlight: { signal: HandledSignal; sole: boolean } | null = null;

/**
 * Re-raise a signal once the SDK's listener is gone, so Node's default action
 * runs: exit with 128 + the signal number, terminal mode reset (#138). Any
 * listener on a signal — ours included — replaces that default, which is why
 * an app with no handler of its own kept running after Ctrl-C or
 * `docker stop` once the SDK had drained. On Windows `process.kill` with a
 * signal is a plain TerminateProcess (exit code 1), so the exit code is set by
 * hand there. Replaceable for tests only.
 */
const defaultReraise = (signal: HandledSignal): void => {
  const code = 128 + (os.constants.signals[signal] ?? (signal === "SIGINT" ? 2 : 15));
  if (process.platform === "win32") process.exit(code);
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(code);
  }
};
let reraise: (signal: HandledSignal) => void = defaultReraise;

/**
 * The first signal drains the registry, then hands the signal back
 * (`finishSignal`); a second one while that is still running hands it back
 * at once, so a second Ctrl-C still ends the process the way it does without
 * the SDK. Whether to re-raise is decided when the signal ARRIVES: an app
 * listener registered with `process.once` is gone by the time the drain is
 * done, and that app must not be killed in the middle of its own shutdown.
 */
function onSignal(signal: HandledSignal): void {
  if (signalInFlight) {
    finishSignal();
    return;
  }
  signalInFlight = { signal, sole: process.listenerCount(signal) === 1 };
  beginProcessShutdown()
    .catch(() => {})
    .then(finishSignal);
}

/**
 * The SDK's listeners are only there to drain; once that is done they are
 * removed. If the SDK was the only listener when the signal arrived, the app
 * relied on Node's default exit, which our listener had suppressed: re-raise
 * so it happens now. An app with its own listener keeps control of what
 * happens next (its listener already ran). Known limit: a library that also
 * only re-raises when it is the last listener (signal-exit, used by execa and
 * ora) does not get its turn either — that app must handle the signal itself.
 */
function finishSignal(): void {
  const inFlight = signalInFlight;
  signalInFlight = null;
  removeSignalHandlers();
  if (inFlight?.sole) reraise(inFlight.signal);
}

/**
 * Prepended, so the SDK's listener runs before the app's and counts them all
 * when the signal arrives — a `process.once` listener registered earlier
 * would otherwise already be gone by the time ours runs.
 */
function installSignalHandlers(): void {
  if (signalListeners) return;
  signalListeners = new Map(SIGNALS.map((signal) => [signal, () => onSignal(signal)]));
  for (const [signal, listener] of signalListeners) process.prependListener(signal, listener);
}

function removeSignalHandlers(): void {
  if (!signalListeners) return;
  for (const [signal, listener] of signalListeners) process.off(signal, listener);
  signalListeners = null;
}

/** @internal Replace (or with `null` restore) the re-raise — exposed for testing only. */
export function _setSignalReraise(fn: ((signal: "SIGTERM" | "SIGINT") => void) | null): void {
  reraise = fn ?? defaultReraise;
}

function newTransport(config: Key, sdkVersion: string): HttpTransport {
  const transport = new HttpTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    sdkVersion,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    immediate: draining,
  });
  if (draining) noteDraining();
  else transport.start();
  return transport;
}

function slotFor(config: Key, sdkVersion: string, onEvict?: (sessionId: string) => void): Slot {
  const key = keyOf(config);
  const existing = slots.get(key);
  if (existing) return existing;
  const slot: Slot = {
    ...createSharedSessions(onEvict),
    live: null,
    transport: {
      send: (events) => {
        // Nothing live: every holder released (the event has nowhere to go,
        // as with a stopped transport) — or a signal drained it, and a
        // request still being served sends best effort through an immediate
        // transport, like a wrap after the signal would get.
        if (!slot.live && draining) slot.live = newTransport(config, sdkVersion);
        slot.live?.send(events);
      },
      flush: () => slot.live?.flush() ?? Promise.resolve(),
      drain: (deadlineMs) => drainTransport(slot.live, deadlineMs),
      shutdown: (deadlineMs) => slot.live?.shutdown(deadlineMs) ?? Promise.resolve(),
    },
  };
  slots.set(key, slot);
  return slot;
}

function entryFor(config: Key, sdkVersion: string, onEvict?: (sessionId: string) => void): Entry {
  const key = keyOf(config);
  const existing = registry.get(key);
  if (existing) return existing;

  const slot = slotFor(config, sdkVersion, onEvict);
  // After a signal the facade may already have started an immediate
  // transport for a request finishing in the grace window: keep it, so the
  // send it has in flight is what a later shutdown() awaits — a fresh one
  // would orphan it mid-send (#142).
  const transport = slot.live ?? newTransport(config, sdkVersion);
  slot.live = transport;
  const entry: Entry = { slot, holders: 0, pinned: false, generation: ++generations };
  registry.set(key, entry);
  installSignalHandlers();
  return entry;
}

/**
 * Everything queued, every batch, giving up at `deadlineMs` (the transport's
 * own when omitted); a transport without `drain` is flushed once.
 */
async function drainTransport(transport: Transport | null, deadlineMs?: number): Promise<void> {
  if (!transport) return;
  if (transport.drain) await transport.drain(deadlineMs);
  else await transport.flush();
}

/**
 * The shared state for a resolved config, pinned: created on first use, then
 * reused by every later wrap with the same endpoint and key and never stopped
 * before the process exits (`withYavio()` has no shutdown). Installs the
 * process signal handlers the first time any state is created.
 */
export function pinShared(
  config: Key,
  sdkVersion: string,
  onEvict?: (sessionId: string) => void,
): SharedState {
  const entry = entryFor(config, sdkVersion, onEvict);
  entry.pinned = true;
  return entry.slot;
}

/**
 * The shared state for a resolved config, held by one more client. Each hold
 * is balanced by one `releaseShared` of that same hold.
 */
export function acquireShared(
  config: Key,
  sdkVersion: string,
  onEvict?: (sessionId: string) => void,
): SharedHold {
  const entry = entryFor(config, sdkVersion, onEvict);
  entry.holders++;
  return { state: entry.slot, generation: entry.generation };
}

/** Is this hold on the transport that is live for its config right now? */
export function isLiveHold(config: Key, hold: SharedHold): boolean {
  return registry.get(keyOf(config))?.generation === hold.generation;
}

/**
 * Deliver everything queued before this call, then release one client's
 * hold on a config's state. First the signal drain, if one is running or
 * ran. A hold on a transport that is no longer live (a signal drained it,
 * or it stopped and a successor started) releases nothing — but still
 * drains the key's current transport, through which a request served after
 * the signal sent its events (#142). The transport stops — so a later wrap
 * starts afresh — only when no client holds it and no `withYavio()` call
 * pinned it; otherwise the other holders keep delivering through it, with
 * everything this client queued delivered first. Every drain or stop this
 * causes runs under the releasing config's own `shutdownTimeoutMs`, not the
 * transport creator's.
 */
export async function releaseShared(config: Key, hold: SharedHold): Promise<void> {
  const key = keyOf(config);
  const deadlineMs = config.shutdownTimeoutMs;
  if (signalDrain) await signalDrain;
  const entry = registry.get(key);
  if (!entry || entry.generation !== hold.generation) {
    await drainTransport(slots.get(key)?.live ?? null, deadlineMs);
    return;
  }
  entry.holders = Math.max(0, entry.holders - 1);
  if (entry.holders > 0 || entry.pinned) {
    await drainTransport(entry.slot.live, deadlineMs);
    return;
  }
  registry.delete(key);
  const live = entry.slot.live;
  entry.slot.live = null;
  if (live) await live.shutdown(deadlineMs);
}

/**
 * A `shutdown()` without a hold to release (a second call; a signal drained
 * the hold and nothing re-wrapped since): the signal drain, then whatever
 * the key's live transport still carries (#142). Never stops anything.
 */
export async function settleShared(config: Key): Promise<void> {
  if (signalDrain) await signalDrain;
  await drainTransport(slots.get(keyOf(config))?.live ?? null, config.shutdownTimeoutMs);
}

/**
 * What the SIGTERM/SIGINT handler does: mark the process as draining, so
 * everything created or sent from now on goes out at once, then drain every
 * transport in the registry — each under its own `shutdownTimeoutMs`, the
 * value of the client or `withYavio()` call that created it. The drain is
 * kept in `signalDrain` for every release that follows; the returned
 * promise is this signal's drain alone.
 */
export function beginProcessShutdown(): Promise<void> {
  draining = true;
  const run = shutdownAllShared();
  const previous = signalDrain;
  signalDrain = previous ? Promise.all([previous, run]).then(() => {}) : run;
  return run;
}

/** Drain every transport in the registry (`beginProcessShutdown`, tests). */
export async function shutdownAllShared(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(
    entries.map((entry) => {
      const live = entry.slot.live;
      entry.slot.live = null;
      return live?.shutdown().catch(() => {});
    }),
  );
}

/** @internal Number of live shared states — exposed for testing only. */
export function _sharedStateCount(): number {
  return registry.size;
}

/**
 * Messages that are worth exactly one line per process: the mode a wrap
 * runs in does not change between requests, and a stateless host wraps on
 * every request.
 */
const loggedOnce = new Set<string>();

export function logOnce(key: string, log: () => void): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  log();
}

/**
 * @internal Reset the registry, the warn-once state and the signal handlers —
 * exposed for testing only. Transports are stopped without draining.
 */
export function _resetSharedState(): void {
  for (const entry of registry.values()) {
    entry.slot.live?.shutdown().catch(() => {});
    entry.slot.live = null;
  }
  registry.clear();
  slots.clear();
  draining = false;
  signalDrain = null;
  signalInFlight = null;
  _setSignalReraise(null);
  loggedOnce.clear();
  removeSignalHandlers();
}
