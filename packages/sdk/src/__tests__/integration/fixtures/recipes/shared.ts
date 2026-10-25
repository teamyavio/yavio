/**
 * The README's serverless recipes (#171), "Serverless and edge runtimes":
 * the module every recipe imports. The block between the markers is the
 * README's, byte for byte, with `@yavio/sdk` for the source path below;
 * `readme-recipes.test.ts` compares them and `tsc` checks this file.
 */
// recipe:start
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createYavio } from "../../../../server/index.js";

export const analytics = createYavio({ serverOnly: true });
export const mcp = createMcpHandler(() => analytics.wrap(buildServer()));

function buildServer(): McpServer {
  const server = new McpServer({ name: "example", version: "1.0.0" });
  // server.registerTool(…) as usual
  return server;
}
// recipe:end
