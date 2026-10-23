import {
  AnalyticsRequestError,
  MAX_BACKGROUND_RETRIES,
  fetchAnalytics,
  isRetryableError,
  needsSignIn,
} from "@/lib/analytics/request";
import { afterEach, describe, expect, it, vi } from "vitest";

function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected token '<'");
      return body;
    },
  } as Response;
}

/** The error fetchAnalytics rejects with; fails the test if it resolves. */
async function rejection(url: string): Promise<AnalyticsRequestError> {
  const outcome = await fetchAnalytics(url).then(
    () => undefined,
    (err: AnalyticsRequestError) => err,
  );
  if (!outcome) throw new Error(`fetchAnalytics(${url}) resolved`);
  return outcome;
}

describe("fetchAnalytics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the JSON body of a 2xx answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(200, { steps: [] })));

    await expect(fetchAnalytics("/api/analytics/p/funnels?from=a")).resolves.toEqual({
      steps: [],
    });
  });

  it("throws the route's message with the status and YAVIO code", async () => {
    const message =
      "This query needs more memory than the database allows. Narrow the date range or simplify the query.";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(answer(422, { error: message, code: "YAVIO-3408" })),
    );

    const err = await rejection("/api/analytics/p/funnels");

    expect(err).toBeInstanceOf(AnalyticsRequestError);
    expect(err.message).toBe(message);
    expect(err.status).toBe(422);
    expect(err.code).toBe("YAVIO-3408");
  });

  it.each([
    ["a body that is not JSON (a proxy's HTML page)", undefined],
    ["a JSON null body", null],
    ["a body without error or code", { detail: 1 }],
    ["fields of the wrong type", { error: 42, code: 3405 }],
  ])("falls back to the status for %s", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(504, body)));

    const err = await rejection("/api/analytics/p/overview");

    expect(err).toBeInstanceOf(AnalyticsRequestError);
    expect(err.message).toBe("Request failed (HTTP 504)");
    expect(err.status).toBe(504);
    expect(err.code).toBeUndefined();
  });
});

describe("isRetryableError (#159)", () => {
  const failed = (status: number, code?: string) =>
    new AnalyticsRequestError("failed", status, code);

  it.each([
    // Deterministic: the same request fails the same way.
    ["400 query rejected (YAVIO-3407)", failed(400, "YAVIO-3407"), false],
    ["400 invalid filters (YAVIO-3050)", failed(400, "YAVIO-3050"), false],
    ["422 query memory limit (YAVIO-3408)", failed(422, "YAVIO-3408"), false],
    ["422 without a code", failed(422), false],
    ["504 query timed out (YAVIO-3405)", failed(504, "YAVIO-3405"), false],
    ["504 from a gateway, without a code", failed(504), false],
    ["a deterministic code on a 5xx status", failed(502, "YAVIO-3405"), false],
    ["the memory code on a 5xx status", failed(503, "YAVIO-3408"), false],
    ["401 signed out (YAVIO-3000)", failed(401, "YAVIO-3000"), false],
    ["403 not a member (YAVIO-3102)", failed(403, "YAVIO-3102"), false],
    ["404 project not found (YAVIO-3153)", failed(404, "YAVIO-3153"), false],
    // Transient: a later attempt can succeed.
    ["502 try again later (YAVIO-3406)", failed(502, "YAVIO-3406"), true],
    ["500 without a body", failed(500), true],
    ["503 without a body", failed(503), true],
    ["429 rate limited (YAVIO-3801)", failed(429, "YAVIO-3801"), true],
    ["408 request timeout", failed(408), true],
    ["fetch() rejected (offline)", new TypeError("Failed to fetch"), true],
    ["a 2xx body that is not JSON", new SyntaxError("Unexpected token '<'"), true],
  ])("%s → retryable: %s", (_label, error, retryable) => {
    expect(isRetryableError(error)).toBe(retryable);
  });

  it("caps background retries at five", () => {
    expect(MAX_BACKGROUND_RETRIES).toBe(5);
  });
});

describe("needsSignIn", () => {
  it.each([
    ["401 signed out (YAVIO-3000)", new AnalyticsRequestError("x", 401, "YAVIO-3000"), true],
    ["401 without a code", new AnalyticsRequestError("x", 401), true],
    ["YAVIO-3000 on another status", new AnalyticsRequestError("x", 403, "YAVIO-3000"), true],
    ["403 not a member (YAVIO-3102)", new AnalyticsRequestError("x", 403, "YAVIO-3102"), false],
    ["422 query memory limit", new AnalyticsRequestError("x", 422, "YAVIO-3408"), false],
    ["fetch() rejected (offline)", new TypeError("Failed to fetch"), false],
  ])("%s → sign in: %s", (_label, error, expected) => {
    expect(needsSignIn(error)).toBe(expected);
  });
});
