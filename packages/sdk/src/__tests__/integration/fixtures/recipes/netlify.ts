/** The README's Netlify Functions recipe (#171), byte for byte between the markers but for the "fixture only" line. */
// recipe:start
// netlify/functions/mcp.mts
import type { Context } from "@netlify/functions";
import { analytics, mcp } from "./shared.js"; // fixture only

export default async (request: Request, context: Context): Promise<Response> =>
  analytics.flushWhenSent(await mcp.fetch(request), context);
// recipe:end
