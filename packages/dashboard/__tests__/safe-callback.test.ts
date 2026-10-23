import { describe, expect, it } from "vitest";
import { safeCallbackPath } from "../lib/auth/safe-callback";

const ORIGIN = "https://dashboard.example.com";
// Distinct from every accepted result, so a rejection cannot pass by
// resolving to the default destination.
const FALLBACK = "/__fallback";

const ACCEPTED: Array<[raw: string, expected: string]> = [
  ["/", "/"],
  ["/a", "/a"],
  ["/a?x=1#h", "/a?x=1#h"],
  ["/acme/default/overview", "/acme/default/overview"],
  [
    "/acme/default/tools/search_flights?from=2026-10-01&to=2026-10-23",
    "/acme/default/tools/search_flights?from=2026-10-01&to=2026-10-23",
  ],
  ["/acme/default/invocations?tool=a%20b#row-3", "/acme/default/invocations?tool=a%20b#row-3"],
  [
    "/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fclient.example.org%2Fcb&state=xyz",
    "/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fclient.example.org%2Fcb&state=xyz",
  ],
  ["/settings/account?tab=security", "/settings/account?tab=security"],
  ["/a/../b", "/b"],
];

const OUTSIDE_ORIGIN = [
  "//example.org",
  "//example.org/acme/default/overview",
  "/\\example.org",
  "/\\\\example.org",
  "\\\\example.org",
  "\\/example.org",
  "/\t/example.org",
  "/\n/example.org",
  "/\r/example.org",
  " //example.org",
  "\t//example.org",
  "\n//example.org",
  "https://example.org/",
  "http://dashboard.example.com/acme/default/overview",
  "https://dashboard.example.com:8443/acme/default/overview",
  "https://dashboard.example.com@example.org/",
  "https://dashboard.example.com.example.org/",
];

const PATH_LEAVES_ORIGIN = ["/.//example.org", "/a/..//example.org", "/./\\example.org"];

const NON_HTTP = [
  "javascript:void(0)",
  " javascript:void(0)",
  "JaVaScRiPt:void(0)",
  "data:text/html,<p>x</p>",
  "vbscript:void(0)",
  "file:///etc/hosts",
];

describe("safeCallbackPath", () => {
  it("accepts a root-relative path on the app origin and keeps query and fragment", () => {
    for (const [raw, expected] of ACCEPTED) {
      expect(safeCallbackPath(raw, ORIGIN), JSON.stringify(raw)).toBe(expected);
    }
  });

  it("returns a same-origin absolute URL as a root-relative path", () => {
    expect(safeCallbackPath(`${ORIGIN}/acme/default/overview?from=1#top`, ORIGIN)).toBe(
      "/acme/default/overview?from=1#top",
    );
  });

  it("accepts an origin given with a trailing slash", () => {
    expect(safeCallbackPath("/acme/default/overview", `${ORIGIN}/`)).toBe("/acme/default/overview");
  });

  it("falls back when the callback is missing or empty", () => {
    expect(safeCallbackPath(null, ORIGIN)).toBe("/");
    expect(safeCallbackPath(undefined, ORIGIN)).toBe("/");
    expect(safeCallbackPath("", ORIGIN)).toBe("/");
  });

  it("rejects a callback that resolves outside the app origin", () => {
    for (const raw of OUTSIDE_ORIGIN) {
      expect(safeCallbackPath(raw, ORIGIN, FALLBACK), JSON.stringify(raw)).toBe(FALLBACK);
    }
  });

  it("rejects a callback whose resolved path would not stay on the app origin", () => {
    for (const raw of PATH_LEAVES_ORIGIN) {
      expect(safeCallbackPath(raw, ORIGIN, FALLBACK), JSON.stringify(raw)).toBe(FALLBACK);
    }
  });

  it("rejects a callback with a non-http scheme", () => {
    for (const raw of NON_HTTP) {
      expect(safeCallbackPath(raw, ORIGIN, FALLBACK), JSON.stringify(raw)).toBe(FALLBACK);
    }
  });

  it("falls back when the callback or the origin does not parse", () => {
    expect(safeCallbackPath("http://[", ORIGIN, FALLBACK)).toBe(FALLBACK);
    expect(safeCallbackPath("/acme/default/overview", "not an origin", FALLBACK)).toBe(FALLBACK);
    expect(safeCallbackPath("/acme/default/overview", "null", FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when the base parses but has an opaque origin", () => {
    // Two opaque origins both serialize to "null" without being the same
    // origin, so the string comparison alone must not accept them.
    expect(safeCallbackPath("/acme/default/overview", "file:///", FALLBACK)).toBe(FALLBACK);
    expect(safeCallbackPath("file:///acme/default/overview", "file:///", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the given fallback instead of the root", () => {
    expect(safeCallbackPath("//example.org", ORIGIN, "/setup")).toBe("/setup");
    expect(safeCallbackPath(null, ORIGIN, "/setup")).toBe("/setup");
  });

  it("only returns paths that resolve back to the app origin", () => {
    const all = [
      ...ACCEPTED.map(([raw]) => raw),
      ...OUTSIDE_ORIGIN,
      ...PATH_LEAVES_ORIGIN,
      ...NON_HTTP,
    ];
    for (const raw of all) {
      const path = safeCallbackPath(raw, ORIGIN);
      expect(path.startsWith("/") && !path.startsWith("//"), JSON.stringify(raw)).toBe(true);
      expect(new URL(path, ORIGIN).origin, JSON.stringify(raw)).toBe(ORIGIN);
    }
  });
});
