import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthError } from "../lib/oauth/errors";

vi.mock("../lib/oauth/clients", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/oauth/clients")>();
  return {
    ...original,
    resolveClient: vi.fn(),
  };
});

import {
  RedirectAuthorizeError,
  RenderAuthorizeError,
  successRedirect,
  validateAuthorizeRequest,
} from "../lib/oauth/authorize";
import { resolveClient } from "../lib/oauth/clients";

const mockResolveClient = resolveClient as ReturnType<typeof vi.fn>;

const CLAUDE_CLIENT = {
  clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  registrationType: "cimd" as const,
  clientName: "Claude",
  redirectUris: [
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost/callback",
    "http://127.0.0.1/callback",
  ],
};

const VALID = {
  client_id: CLAUDE_CLIENT.clientId,
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  response_type: "code",
  state: "opaque-state-123",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  scope: "analytics:read offline_access",
  resource: "https://dashboard.test/api/mcp",
};

describe("authorization request validation", () => {
  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", "https://dashboard.test");
    vi.stubEnv("APP_URL", "https://dashboard.test");
    mockResolveClient.mockResolvedValue(CLAUDE_CLIENT);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("accepts a fully valid Claude-style request", async () => {
    const request = await validateAuthorizeRequest(VALID);
    expect(request.scope).toBe("analytics:read offline_access");
    expect(request.state).toBe("opaque-state-123");
  });

  it("RENDERS (never redirects) for unknown clients and unregistered redirect URIs", async () => {
    await expect(
      validateAuthorizeRequest({ ...VALID, client_id: undefined }),
    ).rejects.toBeInstanceOf(RenderAuthorizeError);

    mockResolveClient.mockRejectedValue(new OAuthError("invalid_client", "unknown", 401));
    await expect(validateAuthorizeRequest(VALID)).rejects.toBeInstanceOf(RenderAuthorizeError);

    mockResolveClient.mockResolvedValue(CLAUDE_CLIENT);
    await expect(
      validateAuthorizeRequest({ ...VALID, redirect_uri: "https://attacker.example/steal" }),
    ).rejects.toBeInstanceOf(RenderAuthorizeError);
    await expect(
      validateAuthorizeRequest({ ...VALID, redirect_uri: undefined }),
    ).rejects.toBeInstanceOf(RenderAuthorizeError);
  });

  it("matches loopback redirect URIs port-agnostically (Claude Code)", async () => {
    const request = await validateAuthorizeRequest({
      ...VALID,
      redirect_uri: "http://localhost:53211/callback",
    });
    expect(request.redirectUri).toBe("http://localhost:53211/callback");
    await validateAuthorizeRequest({ ...VALID, redirect_uri: "http://127.0.0.1:7777/callback" });
    // but not host or path drift
    await expect(
      validateAuthorizeRequest({ ...VALID, redirect_uri: "http://localhost:1234/other" }),
    ).rejects.toBeInstanceOf(RenderAuthorizeError);
  });

  it("REDIRECTS protocol errors back to the validated client with iss + state", async () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...VALID, response_type: "token" }, "unsupported_response_type"],
      [{ ...VALID, code_challenge: undefined }, "invalid_request"],
      [{ ...VALID, code_challenge_method: "plain" }, "invalid_request"],
      [{ ...VALID, resource: "https://other.example/api/mcp" }, "invalid_target"],
    ];
    for (const [params, expectedError] of cases) {
      const err = await validateAuthorizeRequest(params).then(
        () => {
          throw new Error("expected rejection");
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(RedirectAuthorizeError);
      const url = new URL((err as RedirectAuthorizeError).redirectTo);
      expect(url.origin + url.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
      expect(url.searchParams.get("error")).toBe(expectedError);
      expect(url.searchParams.get("state")).toBe("opaque-state-123");
      expect(url.searchParams.get("iss")).toBe("https://dashboard.test");
    }
  });

  it("defaults empty scope to analytics:read", async () => {
    const request = await validateAuthorizeRequest({ ...VALID, scope: undefined });
    expect(request.scope).toBe("analytics:read");
  });

  it("drops unrequestable scopes instead of failing (RFC 6749 §3.3) but never grants them", async () => {
    // a client that tacks on openid/profile/a vendor scope still connects
    const request = await validateAuthorizeRequest({
      ...VALID,
      scope: "openid profile analytics:read offline_access vendor:thing",
    });
    expect(request.scope).toBe("analytics:read offline_access");

    // asking ONLY for something unrequestable still yields the read scope
    const readOnly = await validateAuthorizeRequest({ ...VALID, scope: "admin:write" });
    expect(readOnly.scope).toBe("analytics:read");
    expect(readOnly.scope).not.toContain("admin:write");
  });

  it("builds success redirects with code, state and iss", async () => {
    const request = await validateAuthorizeRequest(VALID);
    const url = new URL(successRedirect(request, "yvo_ac_test"));
    expect(url.searchParams.get("code")).toBe("yvo_ac_test");
    expect(url.searchParams.get("state")).toBe("opaque-state-123");
    expect(url.searchParams.get("iss")).toBe("https://dashboard.test");
  });
});
