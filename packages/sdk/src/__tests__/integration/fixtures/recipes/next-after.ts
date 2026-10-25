/** The README's Next.js after() recipe (#171), byte for byte between the markers but for the "fixture only" line. */
// recipe:start
import { after } from "next/server";
import { analytics, mcp } from "./shared.js"; // fixture only

export async function POST(request: Request): Promise<Response> {
  after(() => analytics.flush());
  return mcp.fetch(request);
}
// recipe:end
