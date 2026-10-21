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

export interface MockIngestOptions {
  /**
   * Answer every event batch this long after receiving it: a slow or remote
   * ingest, so a shutdown() that resolves before the response is told from
   * one that waits for it (#142). Events are recorded on receipt.
   */
  respondAfterMs?: number;
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
  /** While true, the events endpoint records batches but never answers them. */
  hangEvents: boolean;
  /** Event batches answered so far (a batch counts once its response was written). */
  responded: number;
  /** Events of one type, in order. */
  ofType(eventType: string): Event[];
  /** Cut every open connection, e.g. to fail a pending mint now. */
  dropConnections(): void;
  close(): Promise<void>;
}

/**
 * An ingest that accepts every batch and records it, and mints widget tokens
 * bound to the requesting call's trace id (`tok-<trace>`), like the real one.
 */
export async function startMockIngest(options: MockIngestOptions = {}): Promise<MockIngest> {
  const batches: ReceivedBatch[] = [];
  const events: Event[] = [];
  const mints: string[] = [];
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const ingest: MockIngest = {
    endpoint: "",
    batches,
    events,
    mints,
    hangMints: false,
    hangEvents: false,
    responded: 0,
    ofType: (eventType) => events.filter((e) => e.event_type === eventType),
    dropConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server = createServer((req, res) => {
    // Only the two routes the SDK may call; anything else is a regression, not a batch.
    if (req.method !== "POST" || (req.url !== "/v1/events" && req.url !== "/v1/widget-tokens")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (req.url === "/v1/widget-tokens") {
        const { traceId } = parsed as { traceId: string };
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
      const batch = parsed as Omit<ReceivedBatch, "authorization">;
      batches.push({ ...batch, authorization: req.headers.authorization });
      events.push(...batch.events);
      if (ingest.hangEvents) return;
      const respond = () => {
        ingest.responded++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: batch.events.length, rejected: 0 }));
      };
      if (!options.respondAfterMs) {
        respond();
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(timer);
        respond();
      }, options.respondAfterMs);
      pending.add(timer);
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
  call: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await wrapped.connect(serverTransport);
  const client = new Client({ name: "c", version: "1.0" });
  await client.connect(clientTransport);
  try {
    return await client.callTool(call);
  } finally {
    await client.close();
  }
}

/** A registered tool as the MCP SDK stores it: the (wrapped) handler plus whatever else the SDK keeps. */
export interface RegisteredToolEntry {
  handler: (...args: unknown[]) => Promise<unknown>;
  inputSchema?: unknown;
}

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

/**
 * The registry behind a server (v1 or v2, proxy or raw): the private
 * `_registeredTools` the SDK itself patches — one place to reach into it.
 */
export function registeredTools(server: object): Record<string, RegisteredToolEntry> {
  const tools = (server as { _registeredTools?: Record<string, RegisteredToolEntry> })
    ._registeredTools;
  if (!tools) throw new Error("no _registeredTools on this server");
  return tools;
}

/** One registered tool, or undefined. */
export function registeredTool(server: object, name: string): RegisteredToolEntry | undefined {
  return registeredTools(server)[name];
}

/**
 * Invoke a tool's registered handler directly with a v1 extra: no transport,
 * no protocol layer — exactly what the callback wrapper sees. The call shape
 * follows the SDK: a tool with an input schema gets `(args, extra)`, one
 * without gets `(extra)` only.
 */
export async function callTool(
  raw: McpServer,
  name: string,
  args?: Record<string, unknown>,
  extra: Record<string, unknown> = v1Extra(),
): Promise<unknown> {
  const tool = registeredTool(raw, name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.inputSchema === undefined ? tool.handler(extra) : tool.handler(args ?? {}, extra);
}
