/**
 * Shared pieces for the integration tests: a mock ingest endpoint and a way
 * to invoke a registered tool the way the MCP SDK does.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface MockIngest {
  /** `http://127.0.0.1:<port>/v1/events` */
  endpoint: string;
  /** Every event received so far, in order. */
  events: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** An ingest that accepts every batch and records its events. */
export async function startMockIngest(): Promise<MockIngest> {
  const events: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const batch = JSON.parse(body) as { events: Array<Record<string, unknown>> };
      events.push(...batch.events);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: batch.events.length, rejected: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/events`,
    events,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type ToolHandler = (args: unknown, extra: unknown) => Promise<unknown>;

/**
 * Invoke a tool on the raw server behind a proxy, with the extra the MCP SDK
 * passes (v1 shape). Reaches into `_registeredTools`, as the SDK itself does.
 */
export async function callTool(
  raw: McpServer,
  name: string,
  args: Record<string, unknown> = { q: "x" },
  sessionId = "s-1",
): Promise<unknown> {
  const tools = (raw as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.handler(args, {
    signal: new AbortController().signal,
    requestId: 1,
    sessionId,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  });
}
