import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken } from "../lib/invitation/token";

describe("generateInviteToken", () => {
  it("returns raw token as 64-char hex string", () => {
    const { raw } = generateInviteToken();
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns hash as SHA-256 hex digest", () => {
    const { raw, hash } = generateInviteToken();
    const expected = crypto.createHash("sha256").update(raw).digest("hex");
    expect(hash).toBe(expected);
  });

  it("generates unique tokens on each call", () => {
    const t1 = generateInviteToken();
    const t2 = generateInviteToken();
    expect(t1.raw).not.toBe(t2.raw);
    expect(t1.hash).not.toBe(t2.hash);
  });
});

describe("hashInviteToken", () => {
  it("produces SHA-256 hash of raw token", () => {
    const raw = "a".repeat(64);
    const result = hashInviteToken(raw);
    const expected = crypto.createHash("sha256").update(raw).digest("hex");
    expect(result).toBe(expected);
  });

  it("matches hash from generateInviteToken", () => {
    const { raw, hash } = generateInviteToken();
    expect(hashInviteToken(raw)).toBe(hash);
  });

  it("returns consistent results for same input", () => {
    const raw = "test-token-string";
    expect(hashInviteToken(raw)).toBe(hashInviteToken(raw));
  });
});
