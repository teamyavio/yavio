import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  deleteAccountSchema,
  updateProfileSchema,
} from "../lib/account/validation";

describe("updateProfileSchema", () => {
  it("accepts a valid name", () => {
    const result = updateProfileSchema.safeParse({ name: "Alice" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty name", () => {
    const result = updateProfileSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a name over 100 characters", () => {
    const result = updateProfileSchema.safeParse({ name: "a".repeat(101) });
    expect(result.success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("accepts valid password change", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass123",
      newPassword: "newpass123",
      confirmNewPassword: "newpass123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when passwords do not match", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass123",
      newPassword: "newpass123",
      confirmNewPassword: "different456",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when new password is too short", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass123",
      newPassword: "short",
      confirmNewPassword: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when current password is empty", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "",
      newPassword: "newpass123",
      confirmNewPassword: "newpass123",
    });
    expect(result.success).toBe(false);
  });
});

describe("deleteAccountSchema", () => {
  it("accepts a valid password", () => {
    const result = deleteAccountSchema.safeParse({ password: "secret123" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty password", () => {
    const result = deleteAccountSchema.safeParse({ password: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing password field", () => {
    const result = deleteAccountSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
