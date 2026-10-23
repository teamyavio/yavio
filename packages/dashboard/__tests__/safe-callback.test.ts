import { describe, expect, it } from "vitest";
import { safeCallbackPath } from "../lib/auth/safe-callback";

const ORIGIN = "https://dashboard.example.com";

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
  "javascript:alert(document.domain)",
  " javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<p>x</p>",
  "vbscript:msgbox(1)",
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
      expect(safeCallbackPath(raw, ORIGIN), JSON.stringify(raw)).toBe("/");
    }
  });

  it("rejects a callback whose resolved path would not stay on the app origin", () => {
    for (const raw of PATH_LEAVES_ORIGIN) {
      expect(safeCallbackPath(raw, ORIGIN), JSON.stringify(raw)).toBe("/");
    }
  });

  it("rejects a callback with a non-http scheme", () => {
    for (const raw of NON_HTTP) {
      expect(safeCallbackPath(raw, ORIGIN), JSON.stringify(raw)).toBe("/");
    }
  });

  it("falls back when the callback or the origin does not parse", () => {
    expect(safeCallbackPath("http://[", ORIGIN)).toBe("/");
    expect(safeCallbackPath("/acme/default/overview", "not an origin")).toBe("/");
    expect(safeCallbackPath("/acme/default/overview", "null")).toBe("/");
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
