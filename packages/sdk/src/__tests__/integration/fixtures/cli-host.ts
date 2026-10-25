/**
 * The child of `natural-exit-process.test.ts` (#167 review round 1): a
 * process that ends on its own — a script or CLI with an in-process MCP
 * client over `InMemoryTransport`, so nothing of the app's holds the loop
 * once its calls are done. No signal, no `shutdown()`. Started with
 * `node --import tsx` against the SDK's source.
 *
 * Env: ENDPOINT (the mock ingest); ENTRY = "with" (`withYavio()`) |
 * "create" (`createYavio().wrap()`); SCENARIO = "cli" (3 calls, then
 * nothing) | "rearm" (3 calls; an app `beforeExit` listener schedules 2
 * more calls 300 ms after each of the first two passes, so the process
 * goes on after the SDK's natural-exit drain twice) | "unref-tick" (3 calls; an unref'd interval of
 * the app's makes 2 more calls 250 ms apart, which fire only while the
 * SDK's drain holds the loop — the test makes ingest answer late). Progress
 * goes to stderr; nothing here writes to stdout.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createYavio, withYavio } from "../../../server/index.js";

const endpoint = process.env.ENDPOINT;
if (!endpoint) throw new Error("ENDPOINT is not set");
const scenario = process.env.SCENARIO ?? "cli";
const options = { apiKey: "yav_cli_child", endpoint, serverOnly: true };
const log = (line: string) => process.stderr.write(`[cli] ${line}\n`);

const raw = new McpServer({ name: "cli", version: "1.0.0" });
const server =
  process.env.ENTRY === "create" ? createYavio(options).wrap(raw) : withYavio(raw, options);
server.registerTool("echo", { inputSchema: { q: z.string() } }, async ({ q }) => ({
  content: [{ type: "text", text: q }],
}));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "cli-client", version: "1.0.0" });
await client.connect(clientTransport);
const call = (q: string) => client.callTool({ name: "echo", arguments: { q } });

for (let i = 0; i < 3; i++) await call(`q${i}`);
log("3 calls done");

if (scenario === "rearm") {
  // Two rounds, as Lambda's Node 20/22 client answers a callback handler
  // from beforeExit after every invocation: drain → 2 calls → drain → 2
  // calls → drain.
  let rounds = 0;
  process.on("beforeExit", () => {
    if (rounds >= 2) return;
    rounds++;
    const round = rounds;
    setTimeout(async () => {
      await call(`late${round}a`);
      await call(`late${round}b`);
      log(`round ${round}: 2 late calls done`);
    }, 300);
  });
}
if (scenario === "unref-tick") {
  let n = 0;
  const tick = setInterval(async () => {
    if (n >= 2) {
      clearInterval(tick);
      return;
    }
    n++;
    await call(`tick${n}`);
    log(`tick ${n} done`);
  }, 250);
  tick.unref();
}
process.on("exit", (code) => log(`exit ${code}`));
