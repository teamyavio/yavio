import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateToken, hashToken, verifyPkceS256 } from "../lib/oauth/tokens";

describe("token generation and hashing", () => {
  beforeEach(() => {
    process.env.API_KEY_HASH_SECRET = "test-secret";
  });
  afterEach(() => {
    process.env.API_KEY_HASH_SECRET = undefined;
  });

  it("generates prefixed 256-bit tokens", () => {
    expect(generateToken("at")).toMatch(/^yvo_at_[0-9a-f]{64}$/);
    expect(generateToken("rt")).toMatch(/^yvo_rt_[0-9a-f]{64}$/);
    expect(generateToken("ac")).toMatch(/^yvo_ac_[0-9a-f]{64}$/);
    expect(generateToken("at")).not.toBe(generateToken("at"));
  });

  it("hashes deterministically with the HMAC secret", () => {
    const hash = hashToken("yvo_at_x");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("yvo_at_x")).toBe(hash);
    process.env.API_KEY_HASH_SECRET = "other-secret";
    expect(hashToken("yvo_at_x")).not.toBe(hash);
  });

  it("refuses to hash without a secret", () => {
    process.env.API_KEY_HASH_SECRET = "";
    expect(() => hashToken("x")).toThrow("API_KEY_HASH_SECRET");
  });
});

describe("PKCE S256 verification", () => {
  // RFC 7636 appendix B test vector
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("accepts the RFC 7636 test vector", () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    expect(verifyPkceS256(`${verifier.slice(0, -1)}x`, challenge)).toBe(false);
  });

  it("rejects malformed verifiers without throwing", () => {
    expect(verifyPkceS256("too-short", challenge)).toBe(false);
    expect(verifyPkceS256("", challenge)).toBe(false);
    expect(verifyPkceS256("ü".repeat(50), challenge)).toBe(false);
  });

  it("rejects challenges of the wrong length without throwing", () => {
    expect(verifyPkceS256(verifier, "short")).toBe(false);
    expect(verifyPkceS256(verifier, `${challenge}x`)).toBe(false);
  });
});
