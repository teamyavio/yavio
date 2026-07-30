import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchClientMetadata,
  isAcceptableRedirectUri,
  validateClientIdUrl,
} from "../lib/oauth/cimd";
import { OAuthError } from "../lib/oauth/errors";

describe("client_id URL validation", () => {
  it("accepts plain https URLs", () => {
    expect(validateClientIdUrl("https://claude.ai/oauth/mcp-oauth-client-metadata").hostname).toBe(
      "claude.ai",
    );
  });

  it("rejects credentials, fragments, custom ports and IP literals", () => {
    expect(() => validateClientIdUrl("https://user:pw@example.com/x")).toThrow(OAuthError);
    expect(() => validateClientIdUrl("https://example.com/x#frag")).toThrow(OAuthError);
    expect(() => validateClientIdUrl("https://example.com:8443/x")).toThrow(OAuthError);
    expect(() => validateClientIdUrl("https://93.184.216.34/x")).toThrow(OAuthError);
    expect(() => validateClientIdUrl("https://[2001:db8::1]/x")).toThrow(OAuthError);
    expect(() => validateClientIdUrl("not a url")).toThrow(OAuthError);
  });

  it("rejects non-https outside dev loopback", () => {
    expect(() => validateClientIdUrl("http://example.com/client.json")).toThrow(OAuthError);
    expect(() => validateClientIdUrl("ftp://example.com/x")).toThrow(OAuthError);
  });
});

describe("redirect URI acceptance", () => {
  it("accepts https and loopback http", () => {
    expect(isAcceptableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAcceptableRedirectUri("https://chatgpt.com/connector/oauth/abc123")).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://127.0.0.1/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost:8080/callback")).toBe(true);
  });

  it("rejects non-loopback http, fragments, credentials and garbage", () => {
    expect(isAcceptableRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isAcceptableRedirectUri("https://example.com/cb#fragment")).toBe(false);
    expect(isAcceptableRedirectUri("https://user:pw@example.com/cb")).toBe(false);
    expect(isAcceptableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAcceptableRedirectUri("not-a-url")).toBe(false);
  });
});

describe("client metadata document validation (via dev loopback fetch)", () => {
  let server: http.Server;
  let origin: string;
  let document: unknown;
  let statusCode = 200;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(typeof document === "string" ? document : JSON.stringify(document));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("accepts a valid document whose client_id matches its URL", async () => {
    const clientId = `${origin}/client.json`;
    document = {
      client_id: clientId,
      client_name: "Test Client",
      redirect_uris: ["https://client.example/callback", "http://localhost/callback"],
      token_endpoint_auth_method: "none",
    };
    statusCode = 200;
    const metadata = await fetchClientMetadata(clientId);
    expect(metadata.clientName).toBe("Test Client");
    expect(metadata.redirectUris).toHaveLength(2);
  });

  it("rejects a document claiming a different client_id", async () => {
    const clientId = `${origin}/client.json`;
    document = {
      client_id: "https://attacker.example/other.json",
      redirect_uris: ["https://x.example/cb"],
    };
    await expect(fetchClientMetadata(clientId)).rejects.toMatchObject({ error: "invalid_client" });
  });

  it("rejects documents without acceptable redirect_uris", async () => {
    const clientId = `${origin}/client.json`;
    document = { client_id: clientId, redirect_uris: [] };
    await expect(fetchClientMetadata(clientId)).rejects.toMatchObject({ error: "invalid_client" });
    document = { client_id: clientId, redirect_uris: ["http://evil.example/cb"] };
    await expect(fetchClientMetadata(clientId)).rejects.toMatchObject({ error: "invalid_client" });
    document = { client_id: clientId };
    await expect(fetchClientMetadata(clientId)).rejects.toMatchObject({ error: "invalid_client" });
  });

  it("rejects confidential auth methods (CIMD clients are public)", async () => {
    const clientId = `${origin}/client.json`;
    document = {
      client_id: clientId,
      redirect_uris: ["https://x.example/cb"],
      token_endpoint_auth_method: "client_secret_post",
    };
    await expect(fetchClientMetadata(clientId)).rejects.toMatchObject({ error: "invalid_client" });
  });

  it("maps non-200 responses and invalid JSON to invalid_client (DCR fallback signal)", async () => {
    const clientId = `${origin}/client.json`;
    statusCode = 404;
    document = { client_id: clientId, redirect_uris: ["https://x.example/cb"] };
    await expect(fetchClientMetadata(clientId)).rejects.toMatchObject({ error: "invalid_client" });
    statusCode = 200;
    document = "this is not json";
    await expect(fetchClientMetadata(clientId)).rejects.toMatchObject({ error: "invalid_client" });
  });
});
