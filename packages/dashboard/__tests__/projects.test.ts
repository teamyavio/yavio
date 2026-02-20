import { ErrorCode } from "@yavio/shared/error-codes";
import { describe, expect, it } from "vitest";
import { createProjectSchema, updateProjectSchema } from "../lib/project/validation";

describe("project validation schemas", () => {
  describe("createProjectSchema", () => {
    it("accepts valid input with name only", () => {
      const result = createProjectSchema.safeParse({ name: "My Project" });
      expect(result.success).toBe(true);
    });

    it("accepts name with optional slug", () => {
      const result = createProjectSchema.safeParse({ name: "My Project", slug: "my-project" });
      expect(result.success).toBe(true);
    });

    it("rejects name shorter than 2 characters", () => {
      const result = createProjectSchema.safeParse({ name: "X" });
      expect(result.success).toBe(false);
    });

    it("rejects name longer than 100 characters", () => {
      const result = createProjectSchema.safeParse({ name: "a".repeat(101) });
      expect(result.success).toBe(false);
    });

    it("rejects missing name", () => {
      const result = createProjectSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("updateProjectSchema", () => {
    it("accepts partial update with name only", () => {
      const result = updateProjectSchema.safeParse({ name: "Updated" });
      expect(result.success).toBe(true);
    });

    it("accepts empty object (no fields to update)", () => {
      const result = updateProjectSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});

describe("project error codes", () => {
  it("defines project error codes", () => {
    expect(ErrorCode.DASHBOARD.PROJECT_SLUG_EXISTS).toBe("YAVIO-3152");
    expect(ErrorCode.DASHBOARD.PROJECT_NOT_FOUND).toBe("YAVIO-3153");
  });
});
