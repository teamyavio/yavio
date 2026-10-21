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

type Key = Pick<YavioConfig, "endpoint" | "apiKey">;

const keyOf = (config: Key): string => `${config.endpoint}\n${config.apiKey}`;

/**
 * Set by the signal handler, never cleared (outside tests): the process is
 * on its way out. A transport created from now on sends on every `send()`
 * — no timer will fire for it and no shutdown will drain it — so events
 * from requests still served during the graceful-shutdown window go out
 * best effort, bounded by the fetch timeout and the buffer cap.
 */
let draining = false;

function noteDraining(): void {
  logOnce("draining", () =>
    console.info(
      "[yavio] Shutdown signal received — events from requests served from now on are sent at once, best effort.",
    ),
  );
}

let signalHandlersInstalled = false;
/** A signal is being handled: a second one means "stop waiting". */
let signalInFlight = false;

/**
 * Re-raise a signal once the SDK's listener is gone, so Node's default action
 * runs: exit with 128 + the signal number, terminal mode reset (#138). Any
 * listener on a signal — ours included — replaces that default, which is why
 * an app with no handler of its own kept running after Ctrl-C or
 * `docker stop` once the SDK had drained. Replaceable for tests only.
 */
const defaultReraise = (signal: NodeJS.Signals): void => {
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
};
let reraise = defaultReraise;

/**
 * Node passes the signal's name to its listeners. The first signal drains the
 * registry, then hands the signal back (`finishSignal`); a second one while
 * that is still running hands it back at once, so a second Ctrl-C still ends
 * the process the way it does without the SDK.
 */
const shutdownHandler = (signal: NodeJS.Signals): void => {
  if (signalInFlight) {
    finishSignal(signal);
    return;
  }
  signalInFlight = true;
  beginProcessShutdown()
    .catch(() => {})
    .then(() => finishSignal(signal));
};

/**
 * The SDK's listeners are only there to drain; once that is done they are
 * removed. If nothing else listens for this signal, the app relied on Node's
 * default exit, which our listener had suppressed: re-raise so it happens
 * now. An app with its own listener keeps control of what happens next.
 */
function finishSignal(signal: NodeJS.Signals): void {
  removeSignalHandlers();
  if (process.listenerCount(signal) === 0) reraise(signal);
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);
}

function removeSignalHandlers(): void {
  if (!signalHandlersInstalled) return;
  signalHandlersInstalled = false;
  process.off("SIGTERM", shutdownHandler);
  process.off("SIGINT", shutdownHandler);
}

/** @internal Replace (or with `null` restore) the re-raise — exposed for testing only. */
export function _setSignalReraise(fn: ((signal: NodeJS.Signals) => void) | null): void {
  reraise = fn ?? defaultReraise;
}

function newTransport(config: Key, sdkVersion: string): HttpTransport {
  const transport = new HttpTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    sdkVersion,
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
      drain: () => drainTransport(slot.live),
      shutdown: () => slot.live?.shutdown() ?? Promise.resolve(),
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
  const transport = newTransport(config, sdkVersion);
  slot.live = transport;
  const entry: Entry = { slot, holders: 0, pinned: false, generation: ++generations };
  registry.set(key, entry);
  installSignalHandlers();
  return entry;
}

/** Everything queued, every batch; a transport without `drain` is flushed once. */
async function drainTransport(transport: Transport | null): Promise<void> {
  if (!transport) return;
  if (transport.drain) await transport.drain();
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
 * Drain, then release one client's hold on a config's state. A hold on a
 * transport that is no longer live (a signal drained it, or it stopped and
 * a successor started) releases nothing. The transport stops — so a later
 * wrap starts afresh — only when no client holds it and no `withYavio()`
 * call pinned it; otherwise the other holders keep delivering through it,
 * with everything this client queued delivered first.
 */
export async function releaseShared(config: Key, hold: SharedHold): Promise<void> {
  const key = keyOf(config);
  const entry = registry.get(key);
  if (!entry || entry.generation !== hold.generation) return;
  entry.holders = Math.max(0, entry.holders - 1);
  if (entry.holders > 0 || entry.pinned) {
    await drainTransport(entry.slot.live);
    return;
  }
  registry.delete(key);
  const live = entry.slot.live;
  entry.slot.live = null;
  if (live) await live.shutdown();
}

/**
 * What the SIGTERM/SIGINT handler does: mark the process as draining, so
 * everything created or sent from now on goes out at once, then drain every
 * transport in the registry.
 */
export async function beginProcessShutdown(): Promise<void> {
  draining = true;
  await shutdownAllShared();
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
  signalInFlight = false;
  reraise = defaultReraise;
  loggedOnce.clear();
  removeSignalHandlers();
}
