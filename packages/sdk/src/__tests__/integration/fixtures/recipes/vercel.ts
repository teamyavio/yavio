/** The README's Vercel recipe (#171), byte for byte between the markers but for the "fixture only" line. */
// recipe:start
// app/mcp/route.ts
import { waitUntil } from "@vercel/functions";
import { analytics, mcp } from "./shared.js"; // fixture only

export async function POST(request: Request): Promise<Response> {
  return analytics.flushWhenSent(await mcp.fetch(request), waitUntil);
}
// recipe:end
