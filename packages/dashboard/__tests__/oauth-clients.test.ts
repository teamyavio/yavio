import { beforeEach, describe, expect, it, vi } from "vitest";

const db = { insert: vi.fn(), select: vi.fn() };
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => db) }));
vi.mock("../lib/oauth/cimd", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/oauth/cimd")>();
  return { ...original, fetchClientMetadata: vi.fn() };
});

import { fetchClientMetadata } from "../lib/oauth/cimd";
import { registerDcrClient, resolveClient, validateRedirectUri } from "../lib/oauth/clients";

const mockFetchMetadata = fetchClientMetadata as ReturnType<typeof vi.fn>;

let insertedValues: Record<string, unknown>[];
function chainInsert() {
  db.insert.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      insertedValues.push(v);
      // awaitable AND chainable: a real Promise with the conflict method
      return Object.assign(Promise.resolve(), {
        onConflictDoUpdate: () => Promise.resolve(),
      });
    },
  }));
}
function chainSelect(rows: unknown[]) {
  db.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  }));
}

const CIMD_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

describe("resolveClient", () => {
  beforeEach(() => {
    insertedValues = [];
    vi.clearAllMocks();
    chainInsert();
  });

  it("uses the cached CIMD document while fresh (no refetch)", async () => {
    chainSelect([
      {
        clientId: CIMD_ID,
        clientName: "Claude",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        metadataRefreshedAt: new Date(),
      },
    ]);
    const client = await resolveClient(CIMD_ID);
    expect(client.registrationType).toBe("cimd");
    expect(client.clientName).toBe("Claude");
    expect(mockFetchMetadata).not.toHaveBeenCalled();
  });

  it("refetches a stale CIMD document and upserts the cache", async () => {
    chainSelect([
      {
        clientId: CIMD_ID,
        clientName: "Old Name",
        redirectUris: [],
        metadataRefreshedAt: new Date(Date.now() - 2 * 3600_000),
      },
    ]);
    mockFetchMetadata.mockResolvedValue({
      clientId: CIMD_ID,
      clientName: "Claude",
      clientUri: null,
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const client = await resolveClient(CIMD_ID);
    expect(mockFetchMetadata).toHaveBeenCalledWith(CIMD_ID);
    expect(client.clientName).toBe("Claude");
    expect(insertedValues).toHaveLength(1);
  });

  it("unknown DCR client_id → 401 invalid_client (Claude's re-register signal)", async () => {
    chainSelect([]);
    await expect(resolveClient("yvc_gone")).rejects.toMatchObject({
      error: "invalid_client",
      status: 401,
    });
  });

  it("known DCR client resolves from the database", async () => {
    chainSelect([
      { clientId: "yvc_known", clientName: "CLI", redirectUris: ["http://localhost/callback"] },
    ]);
    const client = await resolveClient("yvc_known");
    expect(client.registrationType).toBe("dcr");
    expect(client.redirectUris).toEqual(["http://localhost/callback"]);
  });
});

describe("validateRedirectUri", () => {
  const client = {
    clientId: "yvc_x",
    registrationType: "dcr" as const,
    clientName: null,
    redirectUris: ["https://chatgpt.com/connector/oauth/cb123", "http://127.0.0.1/callback"],
  };

  it("accepts exact matches and port-agnostic loopback", () => {
    validateRedirectUri(client, "https://chatgpt.com/connector/oauth/cb123");
    validateRedirectUri(client, "http://127.0.0.1:61999/callback");
  });

  it("rejects everything else", () => {
    expect(() =>
      validateRedirectUri(client, "https://chatgpt.com/connector/oauth/other"),
    ).toThrow();
    expect(() => validateRedirectUri(client, "http://127.0.0.1:1234/other-path")).toThrow();
    expect(() => validateRedirectUri(client, "http://evil.example/callback")).toThrow();
    expect(() => validateRedirectUri(client, "not-a-url")).toThrow();
  });
});

describe("registerDcrClient", () => {
  beforeEach(() => {
    insertedValues = [];
    chainInsert();
  });

  it("registers a public client and records application_type", async () => {
    const registration = await registerDcrClient({
      client_name: "Some CLI",
      redirect_uris: ["http://localhost/callback"],
      application_type: "native",
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(registration.clientId).toMatch(/^yvc_[0-9a-f]{32}$/);
    expect(registration.applicationType).toBe("native");
    // requested confidential auth is overridden — we only mint public clients
    expect(insertedValues[0].tokenEndpointAuthMethod).toBe("none");
  });

  it("rejects registrations without acceptable redirect_uris", async () => {
    await expect(registerDcrClient({ redirect_uris: [] })).rejects.toMatchObject({
      error: "invalid_redirect_uri",
    });
    await expect(
      registerDcrClient({ redirect_uris: ["http://evil.example/cb"] }),
    ).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(registerDcrClient({})).rejects.toMatchObject({ error: "invalid_redirect_uri" });
  });
});
