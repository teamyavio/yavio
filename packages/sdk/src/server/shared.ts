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
 *   drains every transport in the registry.
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
 * Lifetime. The state of a key is held by every `createYavio()` client bound
 * to it (a counter) and pinned by the first `withYavio()` call for it (which
 * has no shutdown of its own). `client.shutdown()` flushes and releases that
 * client's hold; the transport stops only when the last hold is gone and
 * nothing pins it — another client's events for the same key keep flowing.
 * The signal handlers drain everything regardless.
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

interface Entry {
  state: SharedState;
  /** Live `createYavio()` clients bound to this key. */
  holders: number;
  /** Set by `withYavio()`, which never releases: the state lives until a signal. */
  pinned: boolean;
}

const registry = new Map<string, Entry>();

type Key = Pick<YavioConfig, "endpoint" | "apiKey">;

const keyOf = (config: Key): string => `${config.endpoint}\n${config.apiKey}`;

let signalHandlersInstalled = false;
const shutdownHandler = (): void => {
  shutdownAllShared().catch(() => {});
};

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);
}

function entryFor(config: Key, sdkVersion: string, onEvict?: (sessionId: string) => void): Entry {
  const key = keyOf(config);
  const existing = registry.get(key);
  if (existing) return existing;

  const transport = new HttpTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    sdkVersion,
  });
  transport.start();
  const entry: Entry = {
    state: { transport, ...createSharedSessions(onEvict) },
    holders: 0,
    pinned: false,
  };
  registry.set(key, entry);
  installSignalHandlers();
  return entry;
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
  return entry.state;
}

/**
 * The shared state for a resolved config, held by one more client. Each
 * `acquireShared` is balanced by one `releaseShared`.
 */
export function acquireShared(
  config: Key,
  sdkVersion: string,
  onEvict?: (sessionId: string) => void,
): SharedState {
  const entry = entryFor(config, sdkVersion, onEvict);
  entry.holders++;
  return entry.state;
}

/** The live shared state for a config, if any — no side effect. */
export function peekShared(config: Key): SharedState | undefined {
  return registry.get(keyOf(config))?.state;
}

/**
 * Flush, then release one client's hold on a config's state. The transport
 * stops — and the state is forgotten, so a later wrap starts afresh — only
 * when no client holds it and no `withYavio()` call pinned it; otherwise the
 * other holders keep delivering through it.
 */
export async function releaseShared(config: Key): Promise<void> {
  const key = keyOf(config);
  const entry = registry.get(key);
  if (!entry) return;
  entry.holders = Math.max(0, entry.holders - 1);
  if (entry.holders > 0 || entry.pinned) {
    await entry.state.transport.flush();
    return;
  }
  registry.delete(key);
  await entry.state.transport.shutdown();
}

/** Drain every transport in the registry (the signal handlers' job). */
export async function shutdownAllShared(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(entries.map((entry) => entry.state.transport.shutdown().catch(() => {})));
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
    entry.state.transport.shutdown().catch(() => {});
  }
  registry.clear();
  loggedOnce.clear();
  if (signalHandlersInstalled) {
    process.off("SIGTERM", shutdownHandler);
    process.off("SIGINT", shutdownHandler);
    signalHandlersInstalled = false;
  }
}
