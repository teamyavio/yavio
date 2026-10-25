/**
 * The child of `freeze-process.test.ts` (#171): a serverless instance that
 * the platform freezes once the response is out (AWS Lambda, Vercel, Cloud
 * Run with request-based billing). The app computes the whole web
 * `Response`, the platform writes it, and the test then stops this process
 * with `SIGSTOP` — no timer runs — and in the end kills it with `SIGKILL`,
 * so no signal handler runs either. Started with `node --import tsx`
 * against the SDK's source.
 *
 * Env: ENDPOINT (the mock ingest); STACK = "v2" (`createMcpHandler`, whose
 * 2025-era answers are Server-Sent Events) | "v1" (the README's stateless
 * Streamable HTTP host on `node:http`, JSON responses, reached through a
 * loopback fetch, as a Lambda adapter reaches an Express app); MODE =
 * "none" (the README before #171: nothing after the response) | "await"
 * (`await analytics.flush()` once the body is complete, before the
 * response is written) | "sent" (`flushWhenSent(response, waitUntil)`) |
 * "early" (`waitUntil(analytics.flush())` right after `fetch()`, the
 * naive placement); TOOL_MS (how long the `echo` tool takes).
 *
 * `waitUntil` is the platform's: the promises it is handed are tracked, and
 * `GET /__quiet` answers once they have all settled — the test freezes the
 * instance after that, as a platform does. Prints `ready <port>`.
 */
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer as McpServerV2, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createYavio } from "../../../server/index.js";

const endpoint = process.env.ENDPOINT;
if (!endpoint) throw new Error("ENDPOINT is not set");
const stack = process.env.STACK ?? "v2";
const mode = process.env.MODE ?? "none";
const toolMs = Number(process.env.TOOL_MS ?? 0);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Once per instance, at module scope, as a function's init code does.
const analytics = createYavio({ apiKey: "yav_freeze", endpoint, serverOnly: true });

async function echo({ q }: { q: string }) {
  if (toolMs > 0) await sleep(toolMs);
  return { content: [{ type: "text" as const, text: q }] };
}

function buildV1(): McpServerV1 {
  const server = new McpServerV1({ name: "fn", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
  return server;
}

function buildV2(): McpServerV2 {
  const server = new McpServerV2({ name: "fn", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
  return server;
}

/** The app: a web `Request` in, a web `Response` out. */
let app: (request: Request) => Promise<Response>;
if (stack === "v2") {
  const mcp = createMcpHandler(() => analytics.wrap(buildV2()));
  app = (request) => mcp.fetch(request);
} else {
  // The README's stateless v1 host, which writes its own response; the
  // instance reaches it over loopback like a Lambda adapter reaches an app.
  const inner = createServer((req, res) => {
    const server = analytics.wrap(buildV1());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => inner.listen(0, "127.0.0.1", resolve));
  const innerUrl = `http://127.0.0.1:${(inner.address() as AddressInfo).port}/mcp`;
  app = async (request) => {
    const headers = new Headers(request.headers);
    for (const name of ["host", "connection", "content-length"]) headers.delete(name);
    return fetch(innerUrl, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    });
  };
}

const background = new Set<Promise<void>>();
const quietWaiters: Array<() => void> = [];
/** The platform's waitUntil: keeps the instance up until the promise settles. */
function waitUntil(promise: Promise<unknown>): void {
  const tracked: Promise<void> = promise.then(
    () => {},
    () => {},
  );
  background.add(tracked);
  void tracked.then(() => {
    background.delete(tracked);
    if (background.size === 0) for (const resolve of quietWaiters.splice(0)) resolve();
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const http = createServer(async (req, res) => {
  if (req.url === "/__quiet") {
    if (background.size > 0) await new Promise<void>((resolve) => quietWaiters.push(resolve));
    res.end("quiet");
    return;
  }
  const body = await readBody(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  let response = await app(
    new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "POST" ? body.toString("utf8") : undefined,
    }),
  );
  if (mode === "early") waitUntil(analytics.flush());
  if (mode === "sent") response = analytics.flushWhenSent(response, waitUntil);
  // The platform takes the whole body before it answers (a buffered Lambda response).
  const bytes = Buffer.from(await response.arrayBuffer());
  if (mode === "await") await analytics.flush();
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "content-length" && name !== "transfer-encoding") out[name] = value;
  });
  res.writeHead(response.status, out);
  res.end(bytes);
});
http.listen(0, "127.0.0.1", () => {
  process.stdout.write(`ready ${(http.address() as AddressInfo).port}\n`);
});
