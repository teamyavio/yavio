/**
 * Which key a tool call's session is derived from (#144).
 *
 * A per-request host (stateless Streamable HTTP, a new McpServer per request)
 * has no session of its own: the transport issues no `Mcp-Session-Id`, and
 * the 2026-07-28 protocol era drops the header altogether. A call that names
 * its conversation some other way is still one conversation, so the SDK looks
 * for a key in this order and takes the first it finds:
 *
 * 1. `Mcp-Session-Id` — the transport's session (`mcp_session_id`);
 * 2. `_meta["openai/session"]` — ChatGPT (`openai_session`);
 * 3. `_meta["vscode.conversationId"]` — VS Code / Copilot Chat, from any
 *    client (`vscode_conversation`);
 * 4. `_meta.threadId` — only from the Codex CLI (`codex-mcp-client` by its
 *    envelope, its initialize handshake or its User-Agent): a bare `threadId`
 *    from a client the SDK does not know could be anything, and merging two
 *    users' calls into one session is worse than splitting one user's
 *    (`codex_thread`);
 * 5. the integrator's `sessionKey` option (`custom`);
 *
 * and without any of them the connection's own session — `per_request` on an
 * HTTP request (on a per-request host that is one call), `connection` on any
 * other transport (stdio: the client process). The built-in keys apply on
 * every transport, so a VS Code stdio server gets one session per
 * conversation instead of one per client process.
 */

import { ErrorCode } from "@yavio/shared/error-codes";
import type { SessionSource } from "@yavio/shared/events";
import type { SessionKeyAuthInfo, SessionKeyFunction } from "../core/types.js";
import { type CallExtra, sessionKeyHeaders } from "./extra.js";
import { logOnce } from "./shared.js";

/** A source that stands for a key; `connection` and `per_request` mean none was found. */
export type KeyedSessionSource = Exclude<SessionSource, "connection" | "per_request">;

/** The key a call's session is derived from, and where it came from. */
export interface SessionKey {
  key: string;
  source: KeyedSessionSource;
}

/** The longest key `sessionKey` may return. */
export const MAX_SESSION_KEY_LENGTH = 1024;

/** The Codex CLI's MCP client name, the only client whose `_meta.threadId` is a session key. */
const CODEX_CLIENT_NAME = "codex-mcp-client";

export interface SessionKeyInputs {
  /** The call's handler context, as read by `readCallExtra()`. */
  ex: CallExtra;
  /** The raw handler context, handed to `sessionKey` as `extra`. */
  extra: unknown;
  /** The connected MCP transport's session id, when it has one. */
  transportSessionId: string | undefined;
  /** The calling client's name (envelope, initialize, User-Agent), computed on demand. */
  clientName: () => string | undefined;
  /** The integrator's option, when set. */
  sessionKey: SessionKeyFunction | undefined;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The first key in the order above, or undefined. `sessionKey` is called only
 * when none of the four before it is there, and at most once per call. Never
 * throws for a failing `sessionKey` (see `callSessionKey`).
 */
export function findSessionKey(inputs: SessionKeyInputs): SessionKey | undefined {
  const { ex } = inputs;
  const mcpSessionId = nonEmptyString(ex.sessionId) ?? nonEmptyString(inputs.transportSessionId);
  if (mcpSessionId) return { key: mcpSessionId, source: "mcp_session_id" };

  const meta = ex.meta;
  const openaiSession = nonEmptyString(meta?.["openai/session"]);
  if (openaiSession) return { key: openaiSession, source: "openai_session" };

  const vscodeConversation = nonEmptyString(meta?.["vscode.conversationId"]);
  if (vscodeConversation) return { key: vscodeConversation, source: "vscode_conversation" };

  const threadId = nonEmptyString(meta?.threadId);
  if (threadId && inputs.clientName()?.toLowerCase() === CODEX_CLIENT_NAME) {
    return { key: threadId, source: "codex_thread" };
  }

  if (inputs.sessionKey) {
    const custom = callSessionKey(inputs.sessionKey, {
      headers: sessionKeyHeaders(ex.requestHeaders),
      meta: meta ?? {},
      authInfo: ex.authInfo as SessionKeyAuthInfo | undefined,
      extra: inputs.extra,
    });
    if (custom !== undefined) return { key: custom, source: "custom" };
  }
  return undefined;
}

/** A thenable, read defensively: a Proxy's `then` getter may throw. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

/**
 * The integrator's key for this call, or undefined for none. `undefined` and
 * `""` are no key, silently. A throw, a promise (an `async` function), any
 * other non-string or a string longer than `MAX_SESSION_KEY_LENGTH` is no key
 * as well, with one `YAVIO-1102` warning per process: the call is recorded
 * without a key — the same as before the option existed — and never fails.
 * This runs outside McpServer's own error handling (the protocol layer opens
 * the call's context before the handler), so nothing may escape it. A
 * rejecting promise is caught here, or it would take the process down as an
 * unhandled rejection.
 */
function callSessionKey(
  sessionKey: SessionKeyFunction,
  request: Parameters<SessionKeyFunction>[0],
): string | undefined {
  let value: unknown;
  try {
    value = sessionKey(request);
  } catch (error) {
    warnSessionKey(`threw ${describeError(error)}`);
    return undefined;
  }
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string") {
    if (value.length <= MAX_SESSION_KEY_LENGTH) return value;
    warnSessionKey(`returned ${value.length} characters (at most ${MAX_SESSION_KEY_LENGTH})`);
    return undefined;
  }
  if (isThenable(value)) {
    try {
      Promise.resolve(value).catch(() => {});
    } catch {
      // Nothing left to guard.
    }
    warnSessionKey("returned a promise — it must be synchronous");
    return undefined;
  }
  warnSessionKey(`returned ${value === null ? "null" : typeof value}, not a string`);
  return undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message;
    return `${error.name}: ${message}`;
  }
  return typeof error;
}

function warnSessionKey(reason: string): void {
  logOnce(ErrorCode.SDK.SESSION_ID_DERIVATION_FAILED, () =>
    console.warn(
      `[${ErrorCode.SDK.SESSION_ID_DERIVATION_FAILED}] sessionKey ${reason} — the call is recorded without a session key (session_source "per_request" over HTTP, "connection" otherwise). sessionKey must return a string of at most ${MAX_SESSION_KEY_LENGTH} characters or undefined, synchronously. Shown once per process.`,
    ),
  );
}
