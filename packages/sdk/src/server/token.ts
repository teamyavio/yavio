export interface MintResult {
  token: string;
  expiresAt: string;
}

export interface MintError {
  status: number;
}

/**
 * Mint short-lived widget JWTs via the ingestion API.
 * Used when the proxy detects a widget response in tool return.
 *
 * Returns `{ token, expiresAt }` on success, `{ status }` on HTTP error,
 * or `null` on network/parse failure.
 */
export async function mintWidgetToken(
  endpoint: string,
  apiKey: string,
  traceId: string,
  sessionId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<MintResult | MintError | null> {
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

    if (!response.ok) return { status: response.status };

    return (await response.json()) as MintResult;
  } catch {
    return null;
  }
}
