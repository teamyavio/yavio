import { ErrorCode } from "@yavio/shared/error-codes";
import { WorkspaceRole } from "@yavio/shared/validation";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// Replicate the update role schema from the route
const updateRoleSchema = z.object({
  role: WorkspaceRole.exclude(["owner"]),
});

describe("member role update schema", () => {
  it("accepts admin role", () => {
    const result = updateRoleSchema.safeParse({ role: "admin" });
    expect(result.success).toBe(true);
  });

  it("accepts member role", () => {
    const result = updateRoleSchema.safeParse({ role: "member" });
    expect(result.success).toBe(true);
  });

  it("accepts viewer role", () => {
    const result = updateRoleSchema.safeParse({ role: "viewer" });
    expect(result.success).toBe(true);
  });

  it("rejects owner role (cannot assign owner)", () => {
    const result = updateRoleSchema.safeParse({ role: "owner" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid role strings", () => {
    const result = updateRoleSchema.safeParse({ role: "superadmin" });
    expect(result.success).toBe(false);
  });

  it("rejects missing role", () => {
    const result = updateRoleSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("member error codes", () => {
  it("defines member operation error codes", () => {
    expect(ErrorCode.DASHBOARD.MEMBER_NOT_FOUND).toBe("YAVIO-3300");
    expect(ErrorCode.DASHBOARD.USER_ALREADY_MEMBER).toBe("YAVIO-3301");
    expect(ErrorCode.DASHBOARD.OWNER_CANNOT_BE_REMOVED).toBe("YAVIO-3101");
  });
});
