/** The README's Cloudflare Workers recipe (#171), byte for byte between the markers but for the "fixture only" line. */
// recipe:start
import { analytics, mcp } from "./shared.js"; // fixture only

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return analytics.flushWhenSent(await mcp.fetch(request), ctx);
  },
};
// recipe:end
