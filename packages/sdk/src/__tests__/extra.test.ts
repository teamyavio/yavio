import { describe, expect, it } from "vitest";
import { clientFromUserAgent } from "../server/extra.js";

/**
 * The User-Agent fallback for the connection's client identity (#142): the
 * first product token only, and never an HTTP library, runtime or browser.
 */
describe("clientFromUserAgent", () => {
  it.each([
    ["openai-mcp/1.0.0", { name: "openai-mcp", version: "1.0.0" }],
    ["openai-mcp/1.0.0 (Codex)", { name: "openai-mcp", version: "1.0.0" }],
    ["  openai-mcp/1.0.0  ", { name: "openai-mcp", version: "1.0.0" }],
    ["Cursor/1.0", { name: "Cursor", version: "1.0" }],
    ["Zed/0.120.0", { name: "Zed", version: "0.120.0" }],
    ["claude-ai", { name: "claude-ai" }],
    ["my_client/2.0.0-beta.1+build.7", { name: "my_client", version: "2.0.0-beta.1+build.7" }],
    ["some-client/1.2 node-fetch/3.0", { name: "some-client", version: "1.2" }],
    ["client/v1 extra", { name: "client", version: "v1" }],
  ])("%s → %o", (userAgent, expected) => {
    expect(clientFromUserAgent(userAgent)).toEqual(expected);
  });

  it.each([
    "node",
    "node-fetch/3.3.2",
    "undici",
    "axios/1.6.0",
    "python-httpx/0.27",
    "python-requests/2.31",
    "aiohttp/3.9",
    "okhttp/4.12",
    "Go-http-client/1.1",
    "curl/8.4.0",
    "Java/17.0.1",
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
    expect(clientFromUserAgent(`${"a".repeat(64)}/1.0`)).toEqual({
      name: "a".repeat(64),
      version: "1.0",
    });
    expect(clientFromUserAgent(`${"a".repeat(65)}/1.0`)).toBeUndefined();
    expect(clientFromUserAgent(`client/${"1".repeat(32)}`)).toEqual({
      name: "client",
      version: "1".repeat(32),
    });
    expect(clientFromUserAgent(`client/${"1".repeat(33)}`)).toBeUndefined();
  });
});
