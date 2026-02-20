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
