export interface MintResult {
  token: string;
  expiresAt: string;
}

export interface MintError {
  status: number;
}

/**
 * The mint runs inside the tool call, after the handler and before the
 * result reaches the client: a slow ingest must not hold the model's answer.
 */
export const WIDGET_TOKEN_TIMEOUT_MS = 2_000;

/**
 * Mint short-lived widget JWTs via the ingestion API.
 * Used when the proxy detects a widget response in tool return.
 *
 * Returns `{ token, expiresAt }` on success, `{ status }` on HTTP error,
 * or `null` on network/parse failure or when `timeoutMs` elapses.
 */
export async function mintWidgetToken(
  endpoint: string,
  apiKey: string,
  traceId: string,
  sessionId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs: number = WIDGET_TOKEN_TIMEOUT_MS,
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return { status: response.status };

    return (await response.json()) as MintResult;
  } catch {
    return null;
  }
}
