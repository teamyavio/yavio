/**
 * Shared pieces for the integration tests: a mock ingest endpoint (events and,
 * for non-serverOnly tests, widget tokens) and two ways to invoke a tool —
 * through a real MCP client over an in-memory transport, or by calling the
 * registered handler directly the way the MCP SDK does.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type Event = Record<string, unknown>;

export interface ReceivedBatch {
  /** The `Authorization` header the batch came with. */
  authorization: string | undefined;
  events: Event[];
  sdk_version?: string;
  sent_at?: string;
}

export interface MockIngest {
  /** `http://127.0.0.1:<port>/v1/events` — the widget-token endpoint sits next to it. */
  endpoint: string;
  /** Every batch received so far, in order. */
  batches: ReceivedBatch[];
  /** Every event received so far, in order (the batches flattened). */
  events: Event[];
  /** The trace ids the widget-token endpoint was asked to bind, in order. */
  mints: string[];
  /** While true, the widget-token endpoint never answers. */
  hangMints: boolean;
  /** Events of one type, in order. */
  ofType(eventType: string): Event[];
  /** Forget what was received (the server keeps running). */
  reset(): void;
  /** Cut every open connection, e.g. to fail a pending mint now. */
  dropConnections(): void;
  close(): Promise<void>;
}

/**
 * An ingest that accepts every batch and records it, and mints widget tokens
 * bound to the requesting call's trace id (`tok-<trace>`), like the real one.
 */
export async function startMockIngest(): Promise<MockIngest> {
  const batches: ReceivedBatch[] = [];
  const events: Event[] = [];
  const mints: string[] = [];
  const ingest: MockIngest = {
    endpoint: "",
    batches,
    events,
    mints,
    hangMints: false,
    ofType: (eventType) => events.filter((e) => e.event_type === eventType),
    reset() {
      batches.length = 0;
      events.length = 0;
      mints.length = 0;
      ingest.hangMints = false;
    },
    dropConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/widget-tokens") {
        const { traceId } = JSON.parse(body) as { traceId: string };
        mints.push(traceId);
        if (ingest.hangMints) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: `tok-${traceId}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        return;
      }
      const batch = JSON.parse(body) as Omit<ReceivedBatch, "authorization">;
      batches.push({ ...batch, authorization: req.headers.authorization });
      events.push(...batch.events);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: batch.events.length, rejected: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ingest.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/events`;
  return ingest;
}

/**
 * Call one tool through a real MCP client over an in-memory transport: the
 * whole protocol path (initialize, tools/call, our wrappers), as a host would.
 * Connects the server, so use a fresh server or one not connected yet.
 */
export async function callViaClient(
  wrapped: McpServer,
  call: {
    name?: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  } = {},
  options: { listTools?: boolean } = {},
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await wrapped.connect(serverTransport);
  const client = new Client({ name: "c", version: "1.0" });
  await client.connect(clientTransport);
  if (options.listTools) await client.listTools();
  try {
    return await client.callTool({
      name: call.name ?? "get_price",
      arguments: call.arguments ?? { q: "x" },
      _meta: call._meta,
    });
  } finally {
    await client.close();
  }
}

type ToolHandler = (args: unknown, extra: unknown) => Promise<unknown>;

/** The extra the MCP SDK (v1) passes to a tool handler. */
export function v1Extra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal: new AbortController().signal,
    requestId: 1,
    sessionId: "s-1",
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    ...overrides,
  };
}

/** The registered tool behind a server (proxy or raw), reaching into `_registeredTools` as the SDK does. */
export function registeredTool(
  server: McpServer,
  name: string,
): { handler: ToolHandler } | undefined {
  const tools = (
    server as unknown as { _registeredTools?: Record<string, { handler: ToolHandler }> }
  )._registeredTools;
  return tools?.[name];
}

/**
 * Invoke a tool's registered handler directly with a v1 extra: no transport,
 * no protocol layer — exactly what the callback wrapper sees.
 */
export async function callTool(
  raw: McpServer,
  name: string,
  args: Record<string, unknown> | undefined = { q: "x" },
  extra: Record<string, unknown> = v1Extra(),
): Promise<unknown> {
  const tool = registeredTool(raw, name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  // A tool without an input schema takes (extra) only, like the SDK calls it.
  return args === undefined ? tool.handler(extra, undefined) : tool.handler(args, extra);
}
