/**
 * The request context an MCP server hands a tool callback (and the tools/call
 * request handler), read by shape so one code path serves both MCP SDK
 * generations:
 *
 * - MCP SDK v1 (`@modelcontextprotocol/sdk`): `RequestHandlerExtra` —
 *   `{ sessionId, _meta, requestId, requestInfo: { headers, url }, taskId, authInfo, … }`.
 * - MCP SDK v2 (`@modelcontextprotocol/server`): `{ sessionId, mcpReq: { id,
 *   method, _meta, envelope?, … }, http?: { authInfo, req } }` — `_meta` sits
 *   under `mcpReq`, the HTTP request is a web `Request` (its `headers` is a
 *   `Headers` object, not a record; its `url` is deliberately not read, see
 *   `requestUrl`), and on the 2026-07-28 protocol era the client identity
 *   travels per request in `mcpReq.envelope`.
 *
 * Nothing here is typed against either package: the SDK has no runtime import
 * of them, and the structural read is what makes a third shape degrade to
 * "nothing found" instead of a crash. Everything is best effort and never
 * throws.
 */

import { isKnownClientName } from "../core/platform.js";

/** The reserved `_meta` key the 2026-07-28 envelope carries the client identity under. */
const ENVELOPE_CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

export interface CallExtra {
  /** The transport's session id (`Mcp-Session-Id`), when the transport has one. */
  sessionId?: string;
  /** The request `_meta`, verbatim (not a clone). */
  meta?: Record<string, unknown>;
  /** HTTP request headers as a plain record (lower-cased on v2; v1 passes its own record). */
  requestHeaders?: Record<string, unknown>;
  /**
   * The HTTP request URL — v1's `requestInfo.url` only, when it is a string.
   * v2's `http.req.url` is never read: v1 transports pass a `URL` object,
   * which is dropped, so a URL has never reached an event in practice, and a
   * path can carry a secret as easily as a query string (the only part the
   * sanitiser strips). The v2 reader records what v1 records.
   */
  requestUrl?: string;
  /** MCP task id (v1 only). */
  taskId?: string;
  /** Client identity from the v2 per-request envelope, when present. */
  client?: { name?: string; version?: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A `Headers`-like object: web `Headers`, or anything with `forEach(value, name)`. */
function headersToRecord(headers: unknown): Record<string, unknown> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as { forEach?: unknown };
  if (typeof h.forEach === "function") {
    const out: Record<string, unknown> = {};
    try {
      (h as { forEach: (cb: (value: string, name: string) => void) => void }).forEach(
        (value, name) => {
          out[name.toLowerCase()] = value;
        },
      );
      return out;
    } catch {
      return undefined;
    }
  }
  return isRecord(headers) ? headers : undefined;
}

/** Read the parts of a handler context the SDK uses. Never throws. */
export function readCallExtra(extra: unknown): CallExtra {
  const out: CallExtra = {};
  if (!isRecord(extra)) return out;
  try {
    if (typeof extra.sessionId === "string") out.sessionId = extra.sessionId;

    const mcpReq = isRecord(extra.mcpReq) ? extra.mcpReq : undefined;
    const meta = extra._meta ?? mcpReq?._meta;
    if (isRecord(meta)) out.meta = meta;

    if (typeof extra.taskId === "string") out.taskId = extra.taskId;

    // v1: extra.requestInfo = { headers, url }. v2: extra.http.req is a web
    // Request, of which only the headers are read.
    const requestInfo = isRecord(extra.requestInfo) ? extra.requestInfo : undefined;
    const http = isRecord(extra.http) ? extra.http : undefined;
    const req = http && isRecord(http.req) ? http.req : undefined;
    const headers = headersToRecord(requestInfo?.headers ?? req?.headers);
    if (headers) out.requestHeaders = headers;
    if (typeof requestInfo?.url === "string") out.requestUrl = requestInfo.url;

    const envelope = mcpReq && isRecord(mcpReq.envelope) ? mcpReq.envelope : undefined;
    const clientInfo = envelope?.[ENVELOPE_CLIENT_INFO_KEY];
    if (isRecord(clientInfo)) {
      out.client = {
        name: typeof clientInfo.name === "string" ? clientInfo.name : undefined,
        version: typeof clientInfo.version === "string" ? clientInfo.version : undefined,
      };
    }
  } catch {
    // A context of an unexpected shape yields what was read so far.
  }
  return out;
}

/**
 * MCP clients whose product token the vendor matcher in `core/platform.ts`
 * does not name. Together with `isKnownClientName()` this is the whole
 * allowlist for a User-Agent-derived `client_name` (#142, review round 5):
 * a name lands in the 13-month `stats_daily` client slice, which is never
 * recomputed once the raw rows age out, so an HTTP library, a runtime, a
 * server framework or a client the SDK does not know yet must not get
 * there by merely putting its name first. Lower-case; compared to the
 * lower-cased token.
 */
const KNOWN_MCP_CLIENTS = new Set(["mcp-inspector", "mcp-remote"]);

/** The allowlist: a vendor the platform matcher recognises, or an explicit token. */
function isAcceptedClientName(name: string): boolean {
  return isKnownClientName(name) || KNOWN_MCP_CLIENTS.has(name.toLowerCase());
}

/**
 * The first product token of a User-Agent, `name/version` or a bare
 * `name`, both parts constrained to what a product token holds. Only the
 * first token: whatever follows is the library or platform the client runs
 * on (`Python/3.12 aiohttp/3.9.5` starts with the runtime). A bare token
 * counts only when it is the whole User-Agent (`Claude-User`): a bare
 * first word followed by more — `Visual` from `Visual Studio Code/1.95`,
 * `Faraday` from `Faraday v2.7.4` — is a product whose name has spaces,
 * not a client identifying itself. A version must hold at least one digit
 * (`OpenAI/Python 1.40.0` is the SDK's name and its language, not a
 * version). Whitespace, `;` or the end terminates the token: the RFC 9110
 * form is whitespace, and `Claude-User/1.0; +Claude-User@anthropic.com`
 * puts a `;` after the version (review round 3). The token then still has
 * to name a known MCP client (`isAcceptedClientName()`, review round 5).
 */
const PRODUCT_TOKEN =
  /^([A-Za-z][A-Za-z0-9._-]{0,63})(?:\/([0-9A-Za-z][0-9A-Za-z.+_-]{0,31}))?(?=[\s;]|$)/;

/**
 * The MCP client's own identity from its User-Agent, for a stateless host
 * whose instance never saw `initialize` (#142): the envelope and
 * `getClientVersion()` come first, this is the third source. A long-lived
 * server records the initialize `clientInfo` for the same client, which can
 * differ (ChatGPT's connector sends `openai-mcp/1.0.0` as its User-Agent and
 * `codex-mcp-client` as the clientInfo name when Codex drives it), so the
 * connection event records which source it used. Only a known MCP client
 * is accepted — a vendor `isKnownClientName()` recognises (`openai-mcp`,
 * `Claude-User`, `claude-code`, `cursor`, …) or an allowlisted token
 * (`mcp-inspector`, `mcp-remote`); any other first token (`node`,
 * `Nitro/2.9.0`, `Hono/4.6.0`, `python-httpx/0.27`, a client the SDK does
 * not know yet) yields nothing and the connection stays without a client.
 * Never throws.
 */
export function clientFromUserAgent(
  userAgent: string | undefined,
): { name: string; version: string | undefined } | undefined {
  if (typeof userAgent !== "string") return undefined;
  const trimmed = userAgent.trim();
  const match = PRODUCT_TOKEN.exec(trimmed);
  if (!match || !isAcceptedClientName(match[1])) return undefined;
  const [token, name, version] = match;
  if (version === undefined) return token === trimmed ? { name, version: undefined } : undefined;
  return /[0-9]/.test(version) ? { name, version } : undefined;
}

/** Read a header from a record whose values are strings or string arrays. */
export function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
