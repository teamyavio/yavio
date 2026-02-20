/**
 * Mint short-lived widget JWTs via the ingestion API.
 * Used when the proxy detects a widget response in tool return.
 */
export async function mintWidgetToken(
  endpoint: string,
  apiKey: string,
  traceId: string,
  sessionId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ token: string; expiresAt: string } | null> {
  // Derive widget-tokens URL from events endpoint
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/v1\/events\/?$/, "/v1/widget-tokens");
  const tokenUrl = url.toString();

  try {
    const response = await fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ traceId, sessionId }),
    });

    if (!response.ok) return null;

    return (await response.json()) as { token: string; expiresAt: string };
  } catch {
    return null;
  }
}
