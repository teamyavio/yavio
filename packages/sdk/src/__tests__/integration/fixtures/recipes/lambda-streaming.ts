/** The README's Lambda response streaming recipe (#171), byte for byte between the markers but for the "fixture only" lines. */
// recipe:start
import { Writable } from "node:stream";
import { type HttpEvent, toRequest } from "./lambda-request.js"; // fixture only
import { analytics, mcp } from "./shared.js"; // fixture only

export const handler = awslambda.streamifyResponse(async (event: HttpEvent, responseStream) => {
  const response = await mcp.fetch(toRequest(event));
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
  });
  if (response.body) await response.body.pipeTo(Writable.toWeb(stream));
  else stream.end();
  await analytics.flush();
});
// recipe:end
