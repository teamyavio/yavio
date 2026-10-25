/**
 * The child of `lambda-process.test.ts` (#171): a reduction of the AWS Lambda
 * Node.js runtime interface client (aws-lambda-nodejs-runtime-interface-client
 * v3.3.0, the Node 20/22 runtimes) with a function in it. Its `index.mjs`
 * registers `process.on("beforeExit", BeforeExitListener.invoke)` before the
 * function's module loads; `Runtime.scheduleIteration()` asks the Runtime API
 * for the next event with `setImmediate`. A promise handler's result is
 * posted as soon as the promise settles. A callback handler with
 * `callbackWaitsForEmptyEventLoop` (the default) has its result posted from
 * that `beforeExit` listener, through `setImmediate`, once the loop has
 * emptied — so #178's natural-exit drain runs after every such invocation.
 * The parent serves the Runtime API (`/next`, `/response`) and freezes this
 * process when it asks for the next event, which is what Lambda does.
 * Started with `node --import tsx` against the SDK's source.
 *
 * Env: RUNTIME_API (the parent's Runtime API), ENDPOINT (the mock ingest),
 * STYLE = "async" | "callback", FLUSH = "1" (`await analytics.flush()` before
 * the handler returns or calls back). Each invocation runs one MCP
 * `tools/call` through an in-memory pair on a server wrapped for it, and
 * posts `{ result, beforeExitEmits, registry }`: `registry` is the number of
 * live shared states when the invocation began — 0 once a natural-exit drain
 * has taken the key's entry out, 1 while it is untouched.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createYavio } from "../../../server/index.js";
import { _sharedStateCount } from "../../../server/shared.js";

const runtime = process.env.RUNTIME_API;
const endpoint = process.env.ENDPOINT;
if (!runtime || !endpoint) throw new Error("RUNTIME_API and ENDPOINT must be set");
const style = process.env.STYLE ?? "async";
const flush = process.env.FLUSH === "1";

// --- the runtime client, before the function's module ---------------------
const NO_OP = () => {};
let listener: () => void = NO_OP; // BeforeExitListener
let beforeExitEmits = 0;
process.on("beforeExit", () => {
  beforeExitEmits++;
  listener();
});

// --- the function's module ---------------------------------------------------
const analytics = createYavio({ apiKey: "yav_lambda", endpoint, serverOnly: true });

async function work(q: string): Promise<{ text: string; registry: number }> {
  const registry = _sharedStateCount();
  const server = analytics.wrap(new McpServer({ name: "fn", version: "1.0.0" }));
  server.registerTool("echo", { inputSchema: { q: z.string() } }, async (args) => ({
    content: [{ type: "text" as const, text: args.q }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "fn-client", version: "1.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: "echo",
    arguments: { q },
    _meta: { "openai/session": "conv-lambda" },
  });
  await client.close();
  if (flush) await analytics.flush();
  const content = result.content as Array<{ text: string }>;
  return { text: content[0]?.text ?? "", registry };
}

type Callback = (error: unknown, result?: unknown) => void;
interface Context {
  callbackWaitsForEmptyEventLoop: boolean;
}

const handler =
  style === "callback"
    ? (event: { q: string }, _context: Context, callback: Callback): void => {
        work(event.q).then(
          (result) => callback(null, result),
          (error) => callback(error),
        );
      }
    : async (event: { q: string }) => work(event.q);

// --- the runtime client's loop -----------------------------------------------
const post = (path: string, body: unknown) =>
  fetch(`${runtime}${path}`, { method: "POST", body: JSON.stringify(body) });

function scheduleIteration(): void {
  setImmediate(() => {
    handleOnce().catch((error) => {
      process.stderr.write(`runtime client: ${String(error)}\n`);
      process.exit(1);
    });
  });
}

async function handleOnce(): Promise<void> {
  const invocation = (await (await fetch(`${runtime}/next`)).json()) as {
    id: string;
    event: { q: string };
  };
  const context: Context = { callbackWaitsForEmptyEventLoop: true };
  let done = false;
  const complete = (result: unknown) => {
    if (done) return;
    done = true;
    void post(`/response/${invocation.id}`, { result, beforeExitEmits }).then(scheduleIteration);
  };
  listener = () => complete(null); // _setDefaultExitListener
  const callback: Callback = (error, result) => {
    listener = NO_OP;
    const outcome = error ? { error: String(error) } : result;
    if (!context.callbackWaitsForEmptyEventLoop) complete(outcome);
    else listener = () => setImmediate(() => complete(outcome));
  };
  const returned = (handler as (e: unknown, c: Context, cb: Callback) => unknown)(
    invocation.event,
    context,
    callback,
  );
  if (returned instanceof Promise) {
    returned.then(
      (result) => {
        listener = NO_OP;
        complete(result);
      },
      (error) => {
        listener = NO_OP;
        complete({ error: String(error) });
      },
    );
  }
}

scheduleIteration();
