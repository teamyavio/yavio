import { describe, expect, it } from "vitest";
import { registerSchema } from "../../lib/auth/validation";
import { createWorkspaceSchema } from "../../lib/workspace/validation";

describe("auth flow validation", () => {
  it("validates the full registration flow schema", () => {
    const registerResult = registerSchema.safeParse({
      name: "Test User",
      email: "test@example.com",
      password: "securepassword123",
      confirmPassword: "securepassword123",
    });
    expect(registerResult.success).toBe(true);
  });

  it("validates workspace creation after registration", () => {
    const workspaceResult = createWorkspaceSchema.safeParse({
      name: "Test Workspace",
      slug: "test-workspace",
    });
    expect(workspaceResult.success).toBe(true);
  });

  it("rejects invalid email in registration", () => {
    const result = registerSchema.safeParse({
      name: "Test",
      email: "not-an-email",
      password: "password123",
      confirmPassword: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("validates invitation acceptance flow", () => {
    // Token validation would happen at the API layer
    // Here we verify the error codes exist for the flow
    const { ErrorCode } = require("@yavio/shared/error-codes");
    expect(ErrorCode.DASHBOARD.INVALID_INVITE_TOKEN).toBe("YAVIO-3008");
    expect(ErrorCode.DASHBOARD.USER_ALREADY_MEMBER).toBe("YAVIO-3301");
  });
});
