/**
 * Shared pieces for the integration tests: a mock ingest endpoint (events and,
 * for non-serverOnly tests, widget tokens) and two ways to invoke a tool —
 * through a real MCP client over an in-memory transport, or by calling the
 * registered handler directly the way the MCP SDK does.
 */
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type Event = Record<string, unknown>;

export interface ReceivedBatch {
  /** The `Authorization` header the batch came with. */
  authorization: string | undefined;
  /** `Date.now()` when the batch was received, and when its response was written. */
  receivedAt: number;
  answeredAt?: number;
  /** `Date.now()` when the client closed the connection before any response was written: its fetch was aborted (#148 review round 3). */
  abortedAt?: number;
  /** The status the batch was answered with, once it was. */
  status?: number;
  events: Event[];
  sdk_version?: string;
  sent_at?: string;
}

/** How long to wait before answering a batch: a fixed delay, or one decided per batch. */
export type RespondAfter = number | ((batch: ReceivedBatch) => number);

export interface MockIngestOptions {
  /**
   * Answer every event batch this long after receiving it: a slow or remote
   * ingest, so a shutdown() that resolves before the response is told from
   * one that waits for it (#142). A function decides per batch, so one
   * batch can be answered later than the rest. Events are recorded on
   * receipt. Changeable afterwards through `ingest.respondAfterMs`.
   */
  respondAfterMs?: RespondAfter;
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
  /**
   * While set, the events endpoint answers every batch with this status
   * instead of 200 — a 400 the SDK gives up on at once, a 503 it retries —
   * recorded and counted as responded like any other answer (#148 review
   * round 2).
   */
  failWith: number | undefined;
  /**
   * Answers for the next event batches, one per batch, before `failWith`
   * and everything else: a status (recorded and counted as responded), or
   * "reset" to destroy the connection without an answer (recorded with
   * `abortedAt`) — a one-off 5xx or reset at the signal (#164).
   */
  failNext: Array<number | "reset">;
  /**
   * Answer every batch held back by `hangEvents` with 200 now, so the SDK's
   * fetch settles instead of failing when `close()` cuts the socket — a
   * failed fetch would retry (`YAVIO-1200`) into the next test's output.
   */
  answerHung(): Promise<void>;
  /** Event batches answered so far (a batch counts once its response was written). */
  responded: number;
  /** The delay before a batch is answered, as given to `startMockIngest`; may be changed per test. */
  respondAfterMs: RespondAfter | undefined;
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
  /** Batches a delayed responder still holds, by their timer: answered on `close()`. */
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  const hung: Array<() => void> = [];
  const ingest: MockIngest = {
    endpoint: "",
    batches,
    events,
    mints,
    hangMints: false,
    hangEvents: false,
    failWith: undefined,
    failNext: [],
    responded: 0,
    respondAfterMs: options.respondAfterMs,
    ofType: (eventType) => events.filter((e) => e.event_type === eventType),
    dropConnections: () => server.closeAllConnections(),
    answerHung: async () => {
      for (const respond of hung.splice(0)) respond();
      // Let the responses reach the client before the caller closes the server.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    close: async () => {
      // A batch still held by a delayed responder is answered with 200 now,
      // like `answerHung()`, so the SDK's fetch settles instead of failing
      // when the sockets are cut (a failed fetch retries, `YAVIO-1200`).
      const late = [...pending.values()];
      for (const timer of pending.keys()) clearTimeout(timer);
      pending.clear();
      for (const respond of late) respond();
      if (late.length > 0) await new Promise((resolve) => setTimeout(resolve, 20));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
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
      const batch = parsed as Omit<ReceivedBatch, "authorization" | "receivedAt">;
      const received: ReceivedBatch = {
        ...batch,
        authorization: req.headers.authorization,
        receivedAt: Date.now(),
      };
      batches.push(received);
      events.push(...batch.events);
      res.on("close", () => {
        if (received.answeredAt === undefined) received.abortedAt = Date.now();
      });
      const respond = () => {
        ingest.responded++;
        received.answeredAt = Date.now();
        received.status = 200;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: batch.events.length, rejected: 0 }));
      };
      const next = ingest.failNext.shift();
      if (next === "reset") {
        req.socket.destroy();
        return;
      }
      if (next !== undefined) {
        ingest.responded++;
        received.answeredAt = Date.now();
        received.status = next;
        res.writeHead(next);
        res.end();
        return;
      }
      if (ingest.failWith !== undefined) {
        ingest.responded++;
        received.answeredAt = Date.now();
        received.status = ingest.failWith;
        res.writeHead(ingest.failWith);
        res.end();
        return;
      }
      if (ingest.hangEvents) {
        hung.push(respond);
        return;
      }
      const delay =
        typeof ingest.respondAfterMs === "function"
          ? ingest.respondAfterMs(received)
          : ingest.respondAfterMs;
      if (!delay) {
        respond();
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(timer);
        respond();
      }, delay);
      pending.set(timer, respond);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ingest.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/events`;
  return ingest;
}

/**
 * The port `refusedEndpoint()` returns: below 1024, so no `listen(0)` is ever
 * handed it (every OS's ephemeral range starts far above) and on a default
 * kernel no unprivileged process can bind it. Not port 1: fetch blocks it as
 * a "bad port" before connecting.
 */
const REFUSED_PORT = 2;

/**
 * An endpoint nothing listens on, so a fetch to it is refused at once
 * (ECONNREFUSED), like an ingest that is down or a hostname that resolves
 * to a closed port (#148). Until 2026-10-25 it was a port bound with
 * `listen(0)` and released, and any process's next `listen(0)` could be
 * handed it: in CI a mock ingest in another vitest worker was, took a child
 * host's 53-event drain with a 200, and counted 100 tool calls for its 50,
 * while the child, with nothing left to retry, exited 1.5 s after the
 * signal instead of 3 s. Checked on every call: where something does
 * listen there, this throws instead of a test failing by chance.
 */
export async function refusedEndpoint(): Promise<string> {
  const problem = await new Promise<string | undefined>((resolve) => {
    const socket = connect(REFUSED_PORT, "127.0.0.1");
    socket.setTimeout(2_000, () => {
      socket.destroy();
      resolve("no answer within 2 s");
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve("something listens there");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ECONNREFUSED" ? undefined : (error.code ?? error.message));
    });
  });
  if (problem) {
    throw new Error(
      `refusedEndpoint(): 127.0.0.1:${REFUSED_PORT} must refuse connections — ${problem}`,
    );
  }
  return `http://127.0.0.1:${REFUSED_PORT}/v1/events`;
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
