import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../lib/auth/password";

describe("password hashing", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("test-password-123");
    expect(hash).not.toBe("test-password-123");
    expect(hash).toMatch(/^\$2[aby]?\$/);

    const valid = await verifyPassword("test-password-123", hash);
    expect(valid).toBe(true);
  });

  it("rejects wrong password", async () => {
    const hash = await hashPassword("correct-password");
    const valid = await verifyPassword("wrong-password", hash);
    expect(valid).toBe(false);
  });

  it("produces different hashes for same input (salted)", async () => {
    const hash1 = await hashPassword("same-password");
    const hash2 = await hashPassword("same-password");
    expect(hash1).not.toBe(hash2);
  });
});
