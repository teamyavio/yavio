import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/security/csrf", () => ({ validateCsrf: vi.fn(() => false) }));
vi.mock("@/lib/security/origin", () => ({ validateOrigin: vi.fn(() => false) }));

import { proxy } from "../proxy";

function makeNextRequest(
  url: string,
  opts: { method?: string; cookies?: Record<string, string> } = {},
) {
  const parsedUrl = new URL(url, "http://localhost:3000");
  const headers = new Headers();
  if (opts.cookies) {
    headers.set(
      "cookie",
      Object.entries(opts.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  return {
    method: opts.method ?? "GET",
    nextUrl: parsedUrl,
    url: parsedUrl.toString(),
    headers,
    cookies: {
      get(name: string) {
        const raw = headers.get("cookie") ?? "";
        const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
        return match ? { value: match[1] } : undefined;
      },
    },
  } as Parameters<typeof proxy>[0];
}

describe("proxy — OAuth/MCP path handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves discovery documents without a login redirect", () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/mcp",
    ]) {
      const res = proxy(makeNextRequest(`http://localhost:3000${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("serves /oauth/authorize unauthenticated (page handles its own session redirect)", () => {
    const res = proxy(
      makeNextRequest(
        "http://localhost:3000/oauth/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=abc",
      ),
    );
    expect(res.status).toBe(200);
  });

  it("lets cookieless POSTs through to token, register and MCP endpoints", () => {
    for (const path of ["/api/oauth/token", "/api/oauth/register", "/api/mcp"]) {
      const res = proxy(makeNextRequest(`http://localhost:3000${path}`, { method: "POST" }));
      expect(res.status, path).toBe(200);
    }
  });

  it("still blocks cookieless POSTs to other API routes", () => {
    const res = proxy(makeNextRequest("http://localhost:3000/api/workspaces", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("still redirects unauthenticated dashboard pages to login", () => {
    const res = proxy(makeNextRequest("http://localhost:3000/settings"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("location")).toContain("/login");
  });
});
