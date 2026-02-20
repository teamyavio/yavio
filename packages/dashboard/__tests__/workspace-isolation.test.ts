import { ErrorCode } from "@yavio/shared/error-codes";
import { describe, expect, it } from "vitest";

describe("workspace isolation error codes", () => {
  it("defines access denial error codes", () => {
    expect(ErrorCode.DASHBOARD.NOT_A_MEMBER).toBe("YAVIO-3102");
    expect(ErrorCode.DASHBOARD.INSUFFICIENT_ROLE).toBe("YAVIO-3100");
  });

  it("defines workspace management error codes", () => {
    expect(ErrorCode.DASHBOARD.WORKSPACE_NOT_FOUND).toBe("YAVIO-3151");
    expect(ErrorCode.DASHBOARD.WORKSPACE_SLUG_EXISTS).toBe("YAVIO-3150");
  });
});

// Full RBAC behavioral tests are in __tests__/require-role.test.ts
// Workspace access behavioral tests are in __tests__/workspace-access.test.ts
