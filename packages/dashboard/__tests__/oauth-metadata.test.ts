import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizationServerMetadata, protectedResourceMetadata } from "../lib/oauth/metadata";

/**
 * These pin the exact client-compatibility requirements:
 * - Claude only uses CIMD when client_id_metadata_document_supported is true
 *   AND token_endpoint_auth_methods_supported contains "none" (both required);
 * - refresh tokens are requested because offline_access is in the AS
 *   metadata's scopes_supported — and it must NOT appear in the PRM's.
 */
describe("authorization server metadata", () => {
  beforeEach(() => {
    process.env.APP_URL = "https://dashboard.apps.yavio.ai";
  });
  afterEach(() => {
    process.env.APP_URL = undefined;
  });

  it("satisfies Claude's two-condition CIMD gate", () => {
    const metadata = authorizationServerMetadata();
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("advertises S256 (clients refuse to proceed without it)", () => {
    expect(authorizationServerMetadata().code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises offline_access so clients request refresh tokens", () => {
    expect(authorizationServerMetadata().scopes_supported).toContain("offline_access");
  });

  it("announces iss in authorization responses (RFC 9207)", () => {
    expect(authorizationServerMetadata().authorization_response_iss_parameter_supported).toBe(true);
  });

  it("keeps a DCR registration endpoint as fallback", () => {
    expect(authorizationServerMetadata().registration_endpoint).toBe(
      "https://dashboard.apps.yavio.ai/api/oauth/register",
    );
  });

  it("derives all endpoints from the canonical origin", () => {
    const metadata = authorizationServerMetadata();
    expect(metadata.issuer).toBe("https://dashboard.apps.yavio.ai");
    expect(metadata.authorization_endpoint).toBe("https://dashboard.apps.yavio.ai/oauth/authorize");
    expect(metadata.token_endpoint).toBe("https://dashboard.apps.yavio.ai/api/oauth/token");
  });
});

describe("protected resource metadata", () => {
  beforeEach(() => {
    process.env.APP_URL = "https://dashboard.apps.yavio.ai";
  });
  afterEach(() => {
    process.env.APP_URL = undefined;
  });

  it("identifies the canonical MCP resource and a single AS", () => {
    const metadata = protectedResourceMetadata();
    expect(metadata.resource).toBe("https://dashboard.apps.yavio.ai/api/mcp");
    // Claude only reads the FIRST entry — there must be exactly one.
    expect(metadata.authorization_servers).toEqual(["https://dashboard.apps.yavio.ai"]);
  });

  it("does NOT advertise offline_access (spec: SHOULD NOT in PRM)", () => {
    expect(protectedResourceMetadata().scopes_supported).not.toContain("offline_access");
  });
});
