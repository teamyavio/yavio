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
 * - one widget-token cache per key, so a non-serverOnly stateless app mints
 *   one token per expiry instead of one per request;
 * - exactly one SIGTERM/SIGINT handler pair for the whole process, which
 *   drains every transport in the registry.
 *
 * Still per wrapped instance (in createProxy): the connection's own session,
 * the current MCP transport, the set of tools the instance wrapped. Module
 * level elsewhere, as before: the connection-event dedup (`emittedConnections`)
 * and the discovery dedup (`emittedToolDiscoveries`) in proxy.ts.
 */

/** Cached widget token with parsed expiry for reuse across tool calls. */
export interface CachedWidgetToken {
  token: string;
  expiresAt: number;
}

export interface SharedSessions {
  /**
   * Sessions by their derived id, for servers that serve many conversations
   * (stateless transports, OpenAI's per-call reconnects). Bounded; the least
   * recently used goes first, and its eviction hook drops the connection-event
   * mark so the conversation's next call, which starts a fresh state, emits
   * a fresh connection event.
   */
  sessions: LruMap<string, SessionState>;
  /** Widget token cache, shared across tool calls and instances. */
  tokenCache: { current: CachedWidgetToken | null };
}

export interface SharedState extends SharedSessions {
  transport: Transport;
}

export const MAX_SESSIONS = 1000;

/**
 * Fresh session state with no transport attached. The proxy's default when it
 * is built directly (tests); `sharedStateFor` builds the real one.
 */
export function createSharedSessions(onEvict?: (sessionId: string) => void): SharedSessions {
  return {
    sessions: new LruMap<string, SessionState>(MAX_SESSIONS, (sessionId) => onEvict?.(sessionId)),
    tokenCache: { current: null },
  };
}

const registry = new Map<string, SharedState>();

const keyOf = (config: Pick<YavioConfig, "endpoint" | "apiKey">): string =>
  `${config.endpoint}\n${config.apiKey}`;

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

/**
 * The shared state for a resolved config: created on first use, reused by
 * every later wrap with the same endpoint and key. Installs the process
 * signal handlers the first time any state is created.
 */
export function sharedStateFor(
  config: Pick<YavioConfig, "endpoint" | "apiKey">,
  sdkVersion: string,
  onEvict?: (sessionId: string) => void,
): SharedState {
  const key = keyOf(config);
  const existing = registry.get(key);
  if (existing) return existing;

  const transport = new HttpTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    sdkVersion,
  });
  transport.start();
  const state: SharedState = { transport, ...createSharedSessions(onEvict) };
  registry.set(key, state);
  installSignalHandlers();
  return state;
}

/**
 * Drain and forget the shared state of one config. A later wrap with the
 * same config starts afresh (a stopped transport drops events, so it must
 * not be reused).
 */
export async function shutdownShared(
  config: Pick<YavioConfig, "endpoint" | "apiKey">,
): Promise<void> {
  const key = keyOf(config);
  const state = registry.get(key);
  if (!state) return;
  registry.delete(key);
  await state.transport.shutdown();
}

/** Drain every transport in the registry (the signal handlers' job). */
export async function shutdownAllShared(): Promise<void> {
  const states = [...registry.values()];
  registry.clear();
  await Promise.all(states.map((state) => state.transport.shutdown().catch(() => {})));
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
  for (const state of registry.values()) {
    state.transport.shutdown().catch(() => {});
  }
  registry.clear();
  loggedOnce.clear();
  if (signalHandlersInstalled) {
    process.off("SIGTERM", shutdownHandler);
    process.off("SIGINT", shutdownHandler);
    signalHandlersInstalled = false;
  }
}
