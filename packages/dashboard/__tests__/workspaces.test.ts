import { describe, expect, it } from "vitest";
import { slugify } from "../lib/workspace/slugify";
import { createWorkspaceSchema, updateWorkspaceSchema } from "../lib/workspace/validation";

describe("slugify", () => {
  it("converts name to lowercase slug", () => {
    expect(slugify("My Workspace")).toBe("my-workspace");
  });

  it("removes special characters", () => {
    expect(slugify("Hello World! #1")).toBe("hello-world-1");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("--test--")).toBe("test");
  });

  it("truncates to 48 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(48);
  });
});

describe("createWorkspaceSchema", () => {
  it("validates valid input", () => {
    const result = createWorkspaceSchema.safeParse({ name: "My Workspace" });
    expect(result.success).toBe(true);
  });

  it("rejects too-short name", () => {
    const result = createWorkspaceSchema.safeParse({ name: "x" });
    expect(result.success).toBe(false);
  });

  it("accepts optional slug", () => {
    const result = createWorkspaceSchema.safeParse({ name: "Test", slug: "test-slug" });
    expect(result.success).toBe(true);
  });
});

describe("updateWorkspaceSchema", () => {
  it("allows partial update", () => {
    const result = updateWorkspaceSchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("allows empty object", () => {
    const result = updateWorkspaceSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
