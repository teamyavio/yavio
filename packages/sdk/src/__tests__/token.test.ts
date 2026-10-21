import { describe, expect, it, vi } from "vitest";
import { mintWidgetToken } from "../server/token.js";

describe("mintWidgetToken", () => {
  it("returns token and expiresAt on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "jwt_test", expiresAt: "2026-01-01T00:15:00Z" }),
    });

    const result = await mintWidgetToken(
      "http://localhost:3001/v1/events",
      "yav_test",
      "tr_123",
      "ses_456",
      mockFetch,
    );

    expect(result).toEqual({ token: "jwt_test", expiresAt: "2026-01-01T00:15:00Z" });
  });

  it("derives widget-tokens URL from events endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "jwt", expiresAt: "2026-01-01T00:15:00Z" }),
    });

    await mintWidgetToken(
      "https://ingest.yavio.ai/v1/events",
      "yav_test",
      "tr_123",
      "ses_456",
      mockFetch,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://ingest.yavio.ai/v1/widget-tokens",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends correct headers and body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "jwt", expiresAt: "2026-01-01T00:15:00Z" }),
    });

    await mintWidgetToken(
      "http://localhost:3001/v1/events",
      "yav_key123",
      "tr_abc",
      "ses_def",
      mockFetch,
    );

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer yav_key123",
    });
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ traceId: "tr_abc", sessionId: "ses_def" });
  });

  it("returns error with status on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await mintWidgetToken(
      "http://localhost:3001/v1/events",
      "yav_bad",
      "tr_123",
      "ses_456",
      mockFetch,
    );
    expect(result).toEqual({ status: 401 });
  });

  it("handles endpoint with trailing slash", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "jwt", expiresAt: "2026-01-01T00:15:00Z" }),
    });

    await mintWidgetToken(
      "https://ingest.yavio.ai/v1/events/",
      "yav_test",
      "tr_123",
      "ses_456",
      mockFetch,
    );

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/widget-tokens");
    expect(url).not.toContain("/v1/events");
  });

  it("gives up after the timeout: a hanging endpoint yields null, the fetch is aborted", async () => {
    // Resolves only when its signal fires — a mint endpoint that never answers.
    const hangingFetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const result = await mintWidgetToken(
      "http://localhost:3001/v1/events",
      "yav_test",
      "tr_123",
      "ses_456",
      hangingFetch,
      25,
    );
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    const [, init] = hangingFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it("sends an abort signal with the default 2 s timeout", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "jwt", expiresAt: "2026-01-01T00:15:00Z" }),
    });
    await mintWidgetToken("http://localhost:3001/v1/events", "yav_test", "tr", "ses", mockFetch);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("resolves null for an endpoint that is not a URL — never rejects", async () => {
    const mockFetch = vi.fn();
    await expect(mintWidgetToken("", "yav_test", "tr", "ses", mockFetch)).resolves.toBeNull();
    await expect(
      mintWidgetToken("not a url", "yav_test", "tr", "ses", mockFetch),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await mintWidgetToken(
      "http://localhost:3001/v1/events",
      "yav_test",
      "tr_123",
      "ses_456",
      mockFetch,
    );
    expect(result).toBeNull();
  });
});
