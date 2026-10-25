/**
 * Every SDK log line goes to stderr (#174). On a stdio MCP server stdout is
 * the JSON-RPC wire, and Node's `console.info`, `console.log` and
 * `console.debug` write there: before #174 the SDK's informational lines
 * did, and the client got a parse error for each. In process, vitest owns
 * the streams, so this pins the console method (Node writes `console.error`
 * to stderr); `stdio-process.test.ts` reads a real child's stdout. The 207
 * note is pinned in `http-transport.test.ts`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withYavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { beginProcessShutdown } from "../../server/shared.js";
import { type MockIngest, startMockIngest } from "./helpers.js";

const ok = async () => ({ content: [{ type: "text" as const, text: "ok" }] });

describe("the SDK's informational lines go to stderr, never stdout (#174)", () => {
  let ingest: MockIngest;
  let spies: Record<"info" | "log" | "debug" | "error" | "warn", ReturnType<typeof vi.spyOn>>;

  beforeEach(async () => {
    _resetGlobalState();
    spies = {
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    };
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    _resetGlobalState(); // also clears the draining state the signal drain set
    for (const spy of Object.values(spies)) spy.mockRestore();
    await ingest.close();
  });

  it("the server-only and intent lines, the re-wrap note, the widget override and the signal note: console.error, text unchanged; nothing on console.info, console.log or console.debug", async () => {
    const options = {
      apiKey: "yav_174",
      endpoint: ingest.endpoint,
      serverOnly: true,
      intent: true,
    };
    const raw = new McpServer({ name: "app", version: "1.0" });
    const server = withYavio(raw, options); // the server-only and intent lines
    server.registerTool("echo", { inputSchema: { q: z.string() } }, ok);
    server.registerTool(
      "widget_echo",
      { inputSchema: { q: z.string() }, _meta: { "openai/widgetAccessible": true } },
      ok,
    );
    expect(withYavio(raw, options)).toBe(server); // the re-wrap note

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "c", version: "1.0" });
    await client.connect(clientTransport);
    await client.listTools(); // the widget override
    await beginProcessShutdown(); // what SIGTERM does
    // A request served after the signal: the first one prints the signal note.
    await client.callTool({ name: "echo", arguments: { q: "x", context: "after the signal" } });
    await client.close();
    await vi.waitFor(() => expect(ingest.ofType("tool_call")).toHaveLength(1));

    expect(spies.info.mock.calls).toEqual([]);
    expect(spies.log.mock.calls).toEqual([]);
    expect(spies.debug.mock.calls).toEqual([]);
    expect(spies.error.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      "[yavio] Server-only mode: skipping _meta.yavio injection and widget token minting. The React widget will not auto-connect.",
      "[yavio] Intent capture enabled: tools advertise a 'context' parameter — required on model-facing tools, optional on widget-invoked ones (pass intent: false to disable).",
      "[yavio] withYavio() called on a server that is already wrapped — returning the existing proxy. Shown once per process.",
      '[yavio] Intent context advertised as OPTIONAL on widget-invoked tool "widget_echo" (a required parameter would make the host refuse the widget\'s own calls). Model calls that fill it are still captured.',
      "[yavio] Shutdown signal received — events from requests served from now on are sent at once, best effort.",
    ]);
  });
});
