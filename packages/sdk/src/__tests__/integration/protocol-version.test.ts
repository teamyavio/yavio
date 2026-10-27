/**
 * `protocol_version` and `metadata.client_capabilities` on the connection
 * event, on every transport and both MCP SDK stacks (#170). Through 0.5.4
 * the version came from the `mcp-protocol-version` header only, so every
 * stdio and in-memory connection had NULL on both eras. The sources, in
 * order: the 2026-07-28 envelope, the header, the version the server
 * answered `initialize` with (v2's `getNegotiatedProtocolVersion()`, else
 * the protocol layer's tap on `initialize`, the only source on v1).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioClientV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioClientV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport as InMemoryV1 } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InMemoryTransport as InMemoryV2,
  McpServer as McpServerV2,
} from "@modelcontextprotocol/server";
import type { BaseEvent, ConnectionEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { YavioConfig } from "../../core/types.js";
import { _resetGlobalState, createProxy } from "../../server/proxy.js";
import type { Transport } from "../../transport/types.js";
import { type MockIngest, registeredTool, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "stdio-pv-host.ts");
const SDK_DIR = join(here, "..", "..", "..");

function mockTransport(): Transport & { sent: BaseEvent[][] } {
  const sent: BaseEvent[][] = [];
  return {
    sent,
    send: (events) => {
      sent.push(events);
    },
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const config: YavioConfig = {
  apiKey: "yav_pv",
  endpoint: "http://localhost:3001/v1/events",
  capture: {
    inputValues: true,
    outputValues: true,
    geo: "country",
    conversationId: true,
    tokens: true,
    retries: true,
    rejectedInputValues: false,
  },
  serverOnly: true,
  intent: { enabled: false, required: true, description: "test" },
  tools: {},
  shutdownTimeoutMs: 10_000,
  shutdownTimeoutMsSource: "default",
};

const connections = (sent: BaseEvent[][]): ConnectionEvent[] =>
  sent.flat().filter((e): e is ConnectionEvent => e.event_type === "connection");

const echo = async ({ q }: { q: string }) => ({ content: [{ type: "text" as const, text: q }] });
const CAPABILITIES = { roots: { listChanged: true }, elicitation: {} };

/** A v1 client transport that remembers the version the client settled on. */
function tapClientVersion<T extends object>(transport: T): () => string | undefined {
  let version: string | undefined;
  const t = transport as { setProtocolVersion?: (v: string) => void };
  const original = t.setProtocolVersion?.bind(transport);
  t.setProtocolVersion = (v: string) => {
    version = v;
    original?.(v);
  };
  return () => version;
}

describe("protocol_version off HTTP, MCP SDK v1 (#170)", () => {
  beforeEach(() => _resetGlobalState());

  /**
   * One v1 session over InMemoryTransport through a real client. With
   * `hideHandlerMap`, the low-level server's handler map is invisible while
   * the proxy is built (private API drift) and back before the server runs.
   */
  async function v1Session(hideHandlerMap = false) {
    const server = new McpServerV1({ name: "pv", version: "1.0" });
    const low = server.server as unknown as Record<string, unknown>;
    const handlerMap = low._requestHandlers;
    if (hideHandlerMap) low._requestHandlers = undefined;
    const transport = mockTransport();
    const proxy = createProxy(server, config, transport, "0.5.5");
    if (hideHandlerMap) low._requestHandlers = handlerMap;
    proxy.registerTool("echo", { inputSchema: { q: z.string() } }, echo);
    const [clientTransport, serverTransport] = InMemoryV1.createLinkedPair();
    const negotiated = tapClientVersion(clientTransport);
    await proxy.connect(serverTransport);
    const client = new ClientV1(
      { name: "pv-client", version: "1.0" },
      { capabilities: CAPABILITIES },
    );
    await client.connect(clientTransport);
    await client.callTool({ name: "echo", arguments: { q: "a" } });
    await client.callTool({ name: "echo", arguments: { q: "b" } });
    await client.close();
    return { sent: transport.sent, negotiated: negotiated() };
  }

  it("records the version the server answered initialize with, and the capability names", async () => {
    const { sent, negotiated } = await v1Session();
    const [connection, ...rest] = connections(sent);
    expect(rest).toHaveLength(0);
    expect(negotiated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(connection?.protocol_version).toBe(negotiated);
    expect(connection?.client_name).toBe("pv-client");
    expect(connection?.metadata).toEqual({
      intent_enabled: false,
      client_info_source: "initialize",
      client_capabilities: ["elicitation", "roots"],
    });
  });

  it.each([
    ["2025-03-26", "2025-03-26"],
    ["2099-01-01", "latest"],
  ])(
    "a client asking for %s is recorded with the server's answer (%s)",
    async (asked, expected) => {
      // Raw JSON-RPC, as an older or newer client sends it.
      const server = new McpServerV1({ name: "pv", version: "1.0" });
      const transport = mockTransport();
      const proxy = createProxy(server, config, transport, "0.5.5");
      proxy.registerTool("echo", { inputSchema: { q: z.string() } }, echo);
      const [clientTransport, serverTransport] = InMemoryV1.createLinkedPair();
      const replies = new Map<unknown, { result?: { protocolVersion?: string } }>();
      clientTransport.onmessage = (m) => {
        replies.set((m as { id?: unknown }).id, m as { result?: { protocolVersion?: string } });
      };
      await clientTransport.start();
      await proxy.connect(serverTransport);
      const send = (m: Record<string, unknown>) =>
        clientTransport.send({ jsonrpc: "2.0", ...m } as Parameters<
          typeof clientTransport.send
        >[0]);
      await send({
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: asked,
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      });
      await vi.waitFor(() => expect(replies.has(0)).toBe(true));
      await send({ method: "notifications/initialized" });
      await send({ id: 1, method: "tools/call", params: { name: "echo", arguments: { q: "a" } } });
      await vi.waitFor(() => expect(replies.has(1)).toBe(true));
      const answered = replies.get(0)?.result?.protocolVersion;
      if (expected !== "latest") expect(answered).toBe(expected);
      else expect(answered).not.toBe(asked);
      expect(connections(transport.sent)[0]?.protocol_version).toBe(answered);
      // A client that declares nothing has no capability names.
      expect(connections(transport.sent)[0]?.metadata).not.toHaveProperty("client_capabilities");
    },
  );

  it("leaves the handshake as it was: same result, and a failing initialize fails the same way", async () => {
    const plain = new McpServerV1({ name: "pv", version: "1.0" });
    const [pc, ps] = InMemoryV1.createLinkedPair();
    await plain.connect(ps);
    const plainClient = new ClientV1({ name: "c", version: "1.0" });
    await plainClient.connect(pc);

    const server = new McpServerV1({ name: "pv", version: "1.0" });
    const proxy = createProxy(server, config, mockTransport(), "0.5.5");
    const [wc, ws] = InMemoryV1.createLinkedPair();
    await proxy.connect(ws);
    const client = new ClientV1({ name: "c", version: "1.0" });
    await client.connect(wc);
    expect(client.getServerVersion()).toEqual(plainClient.getServerVersion());
    expect(client.getServerCapabilities()).toEqual(plainClient.getServerCapabilities());
    await plainClient.close();
    await client.close();

    // The tap sits around the stored handler, so a handler that throws
    // reaches the client unchanged.
    const failing = new McpServerV1({ name: "pv", version: "1.0" });
    (failing.server as unknown as { _oninitialize: () => never })._oninitialize = () => {
      throw new Error("initialize refused");
    };
    const failingProxy = createProxy(failing, config, mockTransport(), "0.5.5");
    const [fc, fs] = InMemoryV1.createLinkedPair();
    await failingProxy.connect(fs);
    await expect(new ClientV1({ name: "c", version: "1.0" }).connect(fc)).rejects.toThrow(
      /initialize refused/,
    );
  });

  it("records no version, and still serves, when the handler map is missing at wrap time", async () => {
    // Private API drift: the in-place wrap (and with it the tap) is skipped;
    // the session works as before and the column stays NULL, as on 0.5.4.
    const { sent } = await v1Session(true);
    const all = connections(sent);
    expect(all).toHaveLength(1);
    expect(all[0]?.protocol_version).toBeUndefined();
    expect(all[0]?.client_name).toBe("pv-client");
    expect(sent.flat().filter((e) => e.event_type === "tool_call")).toHaveLength(2);
  });
});

describe("protocol_version off HTTP, MCP SDK v2 (#170)", () => {
  beforeEach(() => _resetGlobalState());

  async function v2Session(withoutAccessor = false) {
    const server = new McpServerV2({ name: "pv", version: "1.0" });
    if (withoutAccessor) {
      // A v2 that dropped the deprecated accessor: the tap answers instead.
      Object.defineProperty(server.server, "getNegotiatedProtocolVersion", { value: undefined });
    }
    const transport = mockTransport();
    const proxy = createProxy(server, config, transport, "0.5.5");
    proxy.registerTool("echo", { inputSchema: { q: z.string() } }, echo);
    const [clientTransport, serverTransport] = InMemoryV2.createLinkedPair();
    await proxy.connect(serverTransport);
    const client = new ClientV2(
      { name: "pv-client", version: "2.0" },
      { capabilities: { sampling: {}, elicitation: {} } },
    );
    await client.connect(clientTransport);
    await client.callTool({ name: "echo", arguments: { q: "a" } });
    const negotiated = client.getNegotiatedProtocolVersion();
    await client.close();
    return { sent: transport.sent, negotiated };
  }

  it.each([false, true])(
    "records the 2025-era version over InMemoryTransport (accessor removed: %s)",
    async (withoutAccessor) => {
      const { sent, negotiated } = await v2Session(withoutAccessor);
      expect(negotiated).toMatch(/^2025-/);
      const [connection] = connections(sent);
      expect(connection?.protocol_version).toBe(negotiated);
      expect(connection?.metadata).toMatchObject({
        client_capabilities: ["elicitation", "sampling"],
      });
    },
  );

  /**
   * One tools/call straight into the registered handler with a v2 context,
   * in a conversation of its own (one connection event per session).
   */
  let conversation = 0;
  async function directCall(mcpReq: Record<string, unknown>, headers?: Record<string, string>) {
    conversation++;
    const server = new McpServerV2({ name: "pv", version: "1.0" });
    const transport = mockTransport();
    const proxy = createProxy(server, config, transport, "0.5.5");
    proxy.registerTool("echo", { inputSchema: { q: z.string() } }, echo);
    const handler = registeredTool(server, "echo")?.handler;
    if (!handler) throw new Error("echo is not registered");
    await handler(
      { q: "a" },
      {
        mcpReq: {
          id: 1,
          method: "tools/call",
          _meta: { "openai/session": `conv-pv-${conversation}` },
          ...mcpReq,
        },
        ...(headers ? { http: { req: { headers: new Headers(headers) } } } : {}),
      },
    );
    return connections(transport.sent)[0];
  }

  const envelope = (version: unknown, capabilities: unknown = { elicitation: {} }) => ({
    envelope: {
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientCapabilities": capabilities,
    },
  });

  it("takes the 2026-07-28 envelope's version, before the header", async () => {
    expect((await directCall(envelope("2026-07-28")))?.protocol_version).toBe("2026-07-28");
    // The header must equal the envelope on Streamable HTTP; a custom
    // transport that does not check gets the body's value.
    const mixed = await directCall(envelope("2026-07-28"), {
      "mcp-protocol-version": "2025-11-25",
    });
    expect(mixed?.protocol_version).toBe("2026-07-28");
  });

  it.each([["latest"], ["2026-7-28"], [20260728], [""]])(
    "drops a non-date envelope version %j and falls back to the header",
    async (value) => {
      expect((await directCall(envelope(value)))?.protocol_version).toBeUndefined();
      const fallback = await directCall(envelope(value), { "mcp-protocol-version": "2025-11-25" });
      expect(fallback?.protocol_version).toBe("2025-11-25");
    },
  );

  it("records capability names only: sorted, object values, protocol spelling, at most 20", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`cap${String(i).padStart(2, "0")}`, {}]),
    );
    const connection = await directCall(
      envelope("2026-07-28", {
        sampling: { tools: {} },
        elicitation: { form: {}, url: {} },
        roots: true,
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } },
        "bad name": {},
        __proto__x: {},
        ...many,
      }),
    );
    const names = (connection?.metadata as { client_capabilities?: string[] }).client_capabilities;
    expect(names).toHaveLength(20);
    expect(names?.slice(0, 3)).toEqual(["cap00", "cap01", "cap02"]);
    expect(names).not.toContain("roots"); // not an object: not a declaration
    expect(names).not.toContain("bad name");
    expect(JSON.stringify(connection)).not.toContain("text/html");
    const few = await directCall(
      envelope("2026-07-28", { sampling: { tools: {} }, elicitation: {} }),
    );
    expect((few?.metadata as { client_capabilities?: string[] }).client_capabilities).toEqual([
      "elicitation",
      "sampling",
    ]);
  });

  it("drops a capability name that can carry an id, as _metaDroppedKeys does (review round 1)", async () => {
    // Recorded whatever the capture flags, so a name with a run of 8 or more
    // hex digits (an install id, a user id, a UUID) is left out.
    const connection = await directCall(
      envelope("2026-07-28", {
        elicitation: {},
        "install-3f2a9c1e4b5d6a7f": {},
        "user/8f14e45fceea167a": {},
        "vendor.example/3f2a9c1e-4b5d-6a7f-8e9d-0c1b2a3f4e5d": {},
        "vendor.example/ui": {},
      }),
    );
    expect(
      (connection?.metadata as { client_capabilities?: string[] }).client_capabilities,
    ).toEqual(["elicitation", "vendor.example/ui"]);
  });

  it("ignores the capabilities of an envelope that names no version (2025-era _meta)", async () => {
    const connection = await directCall({
      envelope: { "io.modelcontextprotocol/clientCapabilities": { experimental: {} } },
    });
    expect(connection?.protocol_version).toBeUndefined();
    expect(connection?.metadata).not.toHaveProperty("client_capabilities");
  });
});

/**
 * A real stdio child driven by a real `StdioClientTransport` (#170, #172).
 * The era is the server entry point's and the client's choice, not the
 * transport's: v2's `serveStdio` serves 2026-07-28 to a client that asks for
 * it (`auto` or a pin) and 2025-11-25 to the default client; v1 has no
 * 2026-07-28. On 2026-07-28 there is no `initialize`, so the client's name
 * comes from the request envelope. Either way each call is one `tool_call`
 * and, with no conversation key, the session is the connection's own.
 */
describe.each(["v1", "v2"] as const)("a real stdio server on MCP SDK %s (#170, #172)", (stack) => {
  let ingest: MockIngest;

  beforeEach(async () => {
    ingest = await startMockIngest();
  });
  // client.close() ends the child: stdin, then SIGTERM, then SIGKILL.
  afterEach(() => ingest.close());

  const modes =
    stack === "v2" ? ([undefined, "auto", { pin: "2026-07-28" }] as const) : ([undefined] as const);

  it.each(modes.map((mode) => [JSON.stringify(mode ?? "default"), mode] as const))(
    "records the negotiated era, one tool_call per call and the client identity's source with the client's %s negotiation",
    async (_label, mode) => {
      const params = {
        command: process.execPath,
        args: ["--import", "tsx", FIXTURE],
        cwd: SDK_DIR,
        stderr: "pipe" as const,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          // tsx keeps its cache under the temp dir.
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          ENDPOINT: ingest.endpoint,
          STACK: stack,
          YAVIO_API_KEY: "",
          YAVIO_ENDPOINT: "",
        },
      };
      let negotiated: () => string | undefined;
      let client: ClientV1 | ClientV2;
      let transport: StdioClientV1 | StdioClientV2;
      if (stack === "v1") {
        transport = new StdioClientV1(params);
        negotiated = tapClientVersion(transport);
        client = new ClientV1({ name: "stdio-pv", version: "1.0" }, { capabilities: CAPABILITIES });
      } else {
        transport = new StdioClientV2(params);
        const v2 = new ClientV2(
          { name: "stdio-pv", version: "2.0" },
          { capabilities: CAPABILITIES, ...(mode ? { versionNegotiation: { mode } } : {}) },
        );
        negotiated = () => v2.getNegotiatedProtocolVersion();
        client = v2;
      }
      await client.connect(transport as never);
      const version = negotiated();
      for (const q of ["a", "b", "c"]) {
        const result = await client.callTool({ name: "echo", arguments: { q } });
        expect((result.content as Array<{ text?: string }>)[0]?.text).toBe(q);
      }
      await client.close();
      await vi.waitFor(
        () => {
          expect(ingest.ofType("connection")).toHaveLength(1);
          expect(ingest.ofType("tool_call")).toHaveLength(3);
        },
        { timeout: 5_000 },
      );

      // v1 has no 2026-07-28: its latest revision is 2025-11-25 (2025-06-18
      // on the 1.24.0 floor).
      if (stack === "v1") expect(version).toMatch(/^2025-/);
      else expect(version).toBe(mode ? "2026-07-28" : "2025-11-25");
      const [connection] = ingest.ofType("connection");
      expect(connection?.protocol_version).toBe(version);
      expect(connection?.client_name).toBe("stdio-pv");
      const metadata = connection?.metadata as Record<string, unknown>;
      expect(metadata.client_capabilities).toEqual(["elicitation", "roots"]);
      expect(metadata.client_info_source).toBe(
        version === "2026-07-28" ? "envelope" : "initialize",
      );

      // One event per call, in order, on the connection's own session.
      const calls = ingest.ofType("tool_call");
      expect(calls.map((e) => (e.input_values as { q?: string }).q)).toEqual(["a", "b", "c"]);
      expect(calls.every((e) => e.event_name === "echo" && e.status === "success")).toBe(true);
      expect(new Set(calls.map((e) => e.session_id))).toEqual(new Set([connection?.session_id]));
      expect(new Set([connection, ...calls].map((e) => e?.session_source))).toEqual(
        new Set(["connection"]),
      );
    },
    30_000,
  );
});
