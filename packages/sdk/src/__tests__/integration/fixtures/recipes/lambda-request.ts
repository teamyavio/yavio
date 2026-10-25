/** The README's AWS Lambda event-to-Request helper (#171), byte for byte between the markers. */
// recipe:start
export interface HttpEvent {
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: { http: { method: string } };
}

export function toRequest(event: HttpEvent): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const body =
    event.body && (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body);
  return new Request(`https://${event.headers.host}${event.rawPath}${query}`, {
    method: event.requestContext.http.method,
    headers: event.headers,
    body: body || undefined,
  });
}
// recipe:end
