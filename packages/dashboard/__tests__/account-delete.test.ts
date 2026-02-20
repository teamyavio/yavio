import { ErrorCode } from "@yavio/shared/error-codes";
import { describe, expect, it } from "vitest";

describe("account deletion error codes", () => {
  it("defines password requirement code", () => {
    expect(ErrorCode.DASHBOARD.ACCOUNT_DELETION_REQUIRES_PASSWORD).toBe("YAVIO-3700");
  });

  it("defines invalid password code", () => {
    expect(ErrorCode.DASHBOARD.INVALID_PASSWORD).toBe("YAVIO-3701");
  });
});

// Behavioral tests for the DELETE route handler are in __tests__/api-routes/account-delete.test.ts
