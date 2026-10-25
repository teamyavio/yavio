import { describe, expect, it } from "vitest";
import { clientFromUserAgent, readCallExtra, sessionKeyHeaders } from "../server/extra.js";

/**
 * The User-Agent fallback for the connection's client identity (#142): the
 * first product token only, as `name/version` with a digit in the version,
 * or a bare `name` when that is the whole User-Agent — and only a name the
 * SDK knows as an MCP client (a vendor the platform matcher recognises, or
 * an allowlisted token such as `mcp-inspector`); any other name, an HTTP
 * library, a runtime or a browser among them, yields nothing (review
 * round 5).
 */
describe("clientFromUserAgent", () => {
  it.each([
    ["openai-mcp/1.0.0", { name: "openai-mcp", version: "1.0.0" }],
    ["openai-mcp/1.0.0 (Codex)", { name: "openai-mcp", version: "1.0.0" }],
    ["  openai-mcp/1.0.0  ", { name: "openai-mcp", version: "1.0.0" }],
    ["Cursor/1.0", { name: "Cursor", version: "1.0" }],
    ["Zed/0.120.0", { name: "Zed", version: "0.120.0" }],
    ["claude-ai/1.0", { name: "claude-ai", version: "1.0" }],
    ["claude-code/1.2.3", { name: "claude-code", version: "1.2.3" }],
    ["cursor/0.42.0", { name: "cursor", version: "0.42.0" }],
    [
      "codex-mcp-client/2.0.0-beta.1+build.7",
      { name: "codex-mcp-client", version: "2.0.0-beta.1+build.7" },
    ],
    ["gemini-cli/1.2 node-fetch/3.0", { name: "gemini-cli", version: "1.2" }],
    ["windsurf/v1 extra", { name: "windsurf", version: "v1" }],
    // Known MCP clients the vendor matcher does not name: the explicit allowlist (review round 5).
    ["mcp-inspector/0.3.0", { name: "mcp-inspector", version: "0.3.0" }],
    ["MCP-Remote/0.1.18", { name: "MCP-Remote", version: "0.1.18" }],
    ["mcp-remote", { name: "mcp-remote", version: undefined }],
    // A `;` after the version terminates the token too (review round 3).
    ["Claude-User/1.0; +Claude-User@anthropic.com", { name: "Claude-User", version: "1.0" }],
    // A bare token that is the whole User-Agent (review round 2).
    ["Claude-User", { name: "Claude-User", version: undefined }],
    ["claude-ai", { name: "claude-ai", version: undefined }],
    ["  Claude-User  ", { name: "Claude-User", version: undefined }],
  ])("%s → %o", (userAgent, expected) => {
    expect(clientFromUserAgent(userAgent)).toEqual(expected);
  });

  it.each([
    // A bare first token followed by more: a product whose name has spaces,
    // not a client (review 2); a bare runtime stays on the generic list.
    "node",
    "Python",
    "Visual Studio Code/1.95",
    "Faraday v2.7.4",
    "Claude-User (bot)",
    // A version without a digit: a language, not a version (review round 2).
    "OpenAI/Python 1.40.0",
    "cursor/beta",
    // A well-formed token that names no known MCP client: a server framework,
    // a runtime or a library that is not on any list yields nothing, so an
    // unknown name never reaches the 13-month client slice (review round 5).
    "Nitro/2.9.0",
    "Hono/4.6.0",
    "h3/1.12.0",
    "some-unknown-lib/1.0",
    "some-unknown-lib",
    "Vercel/1.0",
    "my_client/2.0.0-beta.1+build.7",
    "some-client/1.2 node-fetch/3.0",
    "client/v1 extra",
    // Libraries, runtimes and browsers that put their own name first.
    "node-fetch/3.3.2",
    "undici",
    "axios/1.6.0",
    "python-httpx/0.27",
    "python-requests/2.31",
    "Python/3.12 aiohttp/3.9.5",
    "python-urllib3/2.2",
    "okhttp/4.12",
    "Go-http-client/1.1",
    "curl/8.4.0",
    "HTTPie/3.2.2",
    "Java/17.0.1",
    "Java-http-client/17.0.2",
    "Apache-HttpAsyncClient/4.1.4",
    "ReactorNetty/1.1.0",
    "Vert.x-WebClient/4.5",
    "Dalvik/2.1.0 (Linux; U; Android 14)",
    "Faraday/2.7.4",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/30.0.0 Safari/537.36",
    "Electron/30.0.0",
    "Bun/1.1",
    "Deno/1.40",
    "",
    "   ",
    "/1.0",
    "1client/1.0",
    "client@host/1.0",
  ])("ignores %s", (userAgent) => {
    expect(clientFromUserAgent(userAgent)).toBeUndefined();
  });

  it("never throws on a non-string", () => {
    expect(clientFromUserAgent(undefined)).toBeUndefined();
    expect(clientFromUserAgent(42 as unknown as string)).toBeUndefined();
  });

  it("clamps the name to 64 and the version to 32 characters by not matching longer tokens", () => {
    const name64 = "claude-code".padEnd(64, "a");
    expect(clientFromUserAgent(`${name64}/1.0`)).toEqual({ name: name64, version: "1.0" });
    expect(clientFromUserAgent(`${name64}a/1.0`)).toBeUndefined();
    expect(clientFromUserAgent(`cursor/${"1".repeat(32)}`)).toEqual({
      name: "cursor",
      version: "1".repeat(32),
    });
    expect(clientFromUserAgent(`cursor/${"1".repeat(33)}`)).toBeUndefined();
  });
});

describe("readCallExtra: authInfo (#144)", () => {
  const auth = { token: "t", clientId: "client-1", scopes: [], extra: { sub: "user-1" } };

  it("reads v1's extra.authInfo and v2's ctx.http.authInfo", () => {
    expect(readCallExtra({ authInfo: auth }).authInfo).toBe(auth);
    expect(readCallExtra({ http: { authInfo: auth, req: { headers: {} } } }).authInfo).toBe(auth);
  });

  it("leaves it unset without one, or when it is not an object", () => {
    expect(readCallExtra({}).authInfo).toBeUndefined();
    expect(readCallExtra({ authInfo: "bearer" }).authInfo).toBeUndefined();
  });
});

describe("readCallExtra: v2 and the multi-round-trip retry marker (#168)", () => {
  it("marks a v2 context, and a retry by inputResponses, droppedInputResponseKeys or a requestState", () => {
    expect(readCallExtra({ mcpReq: { id: 1 } })).toMatchObject({ v2: true });
    expect(readCallExtra({ mcpReq: { id: 1 } }).inputRetry).toBeUndefined();
    expect(readCallExtra({ mcpReq: { inputResponses: {} } }).inputRetry).toBe(true);
    expect(readCallExtra({ mcpReq: { droppedInputResponseKeys: ["x"] } }).inputRetry).toBe(true);
    expect(readCallExtra({ mcpReq: { requestState: () => "s1" } }).inputRetry).toBe(true);
    expect(readCallExtra({ mcpReq: { requestState: () => undefined } }).inputRetry).toBeUndefined();
    expect(readCallExtra({ _meta: {} }).v2).toBeUndefined();
  });

  it("a requestState accessor that throws costs only the marker: the rest of the context is still read", () => {
    const extra = {
      sessionId: "s-1",
      mcpReq: {
        _meta: { "openai/session": "conv-1" },
        requestState: () => {
          throw new Error("accessor broke");
        },
      },
      http: { req: { headers: { "user-agent": "openai-mcp/1.0.0" } } },
    };
    const read = readCallExtra(extra);
    expect(read.v2).toBe(true);
    expect(read.inputRetry).toBeUndefined();
    expect(read.meta).toEqual({ "openai/session": "conv-1" });
    expect(read.requestHeaders).toEqual({ "user-agent": "openai-mcp/1.0.0" });
  });
});

describe("sessionKeyHeaders (#144): what sessionKey sees", () => {
  it("lower-cases names and joins a repeated header's values", () => {
    expect(
      sessionKeyHeaders({
        "X-Conversation-Id": "conv-1",
        accept: ["application/json", "text/event-stream"],
      }),
    ).toEqual({ "x-conversation-id": "conv-1", accept: "application/json, text/event-stream" });
  });

  it("is {} without headers, and leaves out values that are not strings", () => {
    expect(sessionKeyHeaders(undefined)).toEqual({});
    expect(sessionKeyHeaders({ a: undefined, b: 1, c: ["x", 2], d: "ok" })).toEqual({ d: "ok" });
  });

  it("is a fresh record: the transport's own is never handed out", () => {
    const headers = { "x-conversation-id": "conv-1" };
    const copy = sessionKeyHeaders(headers);
    copy["x-conversation-id"] = "changed";
    expect(headers["x-conversation-id"]).toBe("conv-1");
  });

  it("keeps a header named __proto__ as an entry, not the record's prototype", () => {
    const headers = JSON.parse('{"__proto__": "x", "a": "b"}') as Record<string, unknown>;
    const out = sessionKeyHeaders(headers);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(out.a).toBe("b");
  });
});
