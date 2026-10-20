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
 *   `Headers` object, not a record), and on the 2026-07-28 protocol era the
 *   client identity travels per request in `mcpReq.envelope`.
 *
 * Nothing here is typed against either package: the SDK has no runtime import
 * of them, and the structural read is what makes a third shape degrade to
 * "nothing found" instead of a crash. Everything is best effort and never
 * throws.
 */

/** The reserved `_meta` key the 2026-07-28 envelope carries the client identity under. */
const ENVELOPE_CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

export interface CallExtra {
  /** The transport's session id (`Mcp-Session-Id`), when the transport has one. */
  sessionId?: string;
  /** The request `_meta`, verbatim (not a clone). */
  meta?: Record<string, unknown>;
  /** HTTP request headers as a plain record (lower-cased on v2; v1 passes its own record). */
  requestHeaders?: Record<string, unknown>;
  /** The HTTP request URL, when known. */
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

    // v1: extra.requestInfo = { headers, url }. v2: extra.http.req is a web Request.
    const requestInfo = isRecord(extra.requestInfo) ? extra.requestInfo : undefined;
    const http = isRecord(extra.http) ? extra.http : undefined;
    const req = http && isRecord(http.req) ? http.req : undefined;
    const source = requestInfo ?? req;
    if (source) {
      const headers = headersToRecord(source.headers);
      if (headers) out.requestHeaders = headers;
      if (typeof source.url === "string") out.requestUrl = source.url;
    }

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
