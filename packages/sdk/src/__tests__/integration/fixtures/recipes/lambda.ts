/** The README's AWS Lambda recipe (#171), byte for byte between the markers but for the "fixture only" lines. */
// recipe:start
import { type HttpEvent, toRequest } from "./lambda-request.js"; // fixture only
import { analytics, mcp } from "./shared.js"; // fixture only

export const handler = async (event: HttpEvent) => {
  const response = await mcp.fetch(toRequest(event));
  const body = await response.text();
  await analytics.flush();
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body };
};
// recipe:end
