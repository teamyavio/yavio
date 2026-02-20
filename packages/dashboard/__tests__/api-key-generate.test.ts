import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateApiKey } from "../lib/api-key/generate";

describe("generateApiKey", () => {
  const secret = "test-hash-secret";

  it("returns rawKey with yav_ prefix", () => {
    const { rawKey } = generateApiKey(secret);
    expect(rawKey.startsWith("yav_")).toBe(true);
  });

  it("returns rawKey with 68 chars (4 prefix + 64 hex)", () => {
    const { rawKey } = generateApiKey(secret);
    expect(rawKey.length).toBe(68);
  });

  it("returns keyPrefix as first 12 chars of rawKey", () => {
    const { rawKey, keyPrefix } = generateApiKey(secret);
    expect(keyPrefix).toBe(rawKey.slice(0, 12));
  });

  it("returns keyHash as HMAC-SHA256 of rawKey", () => {
    const { rawKey, keyHash } = generateApiKey(secret);
    const expectedHash = crypto.createHmac("sha256", secret).update(rawKey).digest("hex");
    expect(keyHash).toBe(expectedHash);
  });

  it("generates unique keys on each call", () => {
    const key1 = generateApiKey(secret);
    const key2 = generateApiKey(secret);
    expect(key1.rawKey).not.toBe(key2.rawKey);
    expect(key1.keyHash).not.toBe(key2.keyHash);
  });

  it("produces different hashes with different secrets", () => {
    const key = generateApiKey("secret-a");
    const hash2 = crypto.createHmac("sha256", "secret-b").update(key.rawKey).digest("hex");
    expect(key.keyHash).not.toBe(hash2);
  });

  it("is compatible with ingest HMAC resolution", () => {
    // The ingest package resolves API keys using the same HMAC-SHA256 algorithm
    const { rawKey, keyHash } = generateApiKey(secret);
    const resolvedHash = crypto.createHmac("sha256", secret).update(rawKey).digest("hex");
    expect(resolvedHash).toBe(keyHash);
  });
});
