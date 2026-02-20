import { ErrorCode } from "@yavio/shared/error-codes";
import { describe, expect, it } from "vitest";

describe("invitation error codes", () => {
  it("defines invitation operation error codes", () => {
    expect(ErrorCode.DASHBOARD.INVITATION_ALREADY_PENDING).toBe("YAVIO-3302");
    expect(ErrorCode.DASHBOARD.INVITATION_NOT_FOUND).toBe("YAVIO-3304");
    expect(ErrorCode.DASHBOARD.INVALID_INVITE_TOKEN).toBe("YAVIO-3008");
  });
});

// Invitation token generation behavioral tests are in __tests__/invite-token.test.ts
