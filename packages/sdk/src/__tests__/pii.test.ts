import { describe, expect, it } from "vitest";
import { stripPii } from "../core/pii.js";

describe("stripPii", () => {
  it("redacts email addresses", () => {
    expect(stripPii("contact user@example.com")).toBe("contact [EMAIL_REDACTED]");
  });

  it("redacts credit card numbers", () => {
    expect(stripPii("card 4111 1111 1111 1111")).toBe("card [CC_REDACTED]");
  });

  it("redacts SSNs", () => {
    expect(stripPii("ssn 123-45-6789")).toBe("ssn [SSN_REDACTED]");
  });

  it("redacts phone numbers", () => {
    expect(stripPii("call +1 (555) 123-4567")).toBe("call [PHONE_REDACTED]");
  });

  it("redacts multiple patterns in one string", () => {
    const input = "email: a@b.com, phone: 555-123-4567";
    const result = stripPii(input);
    expect(result).toContain("[EMAIL_REDACTED]");
    expect(result).toContain("[PHONE_REDACTED]");
  });

  it("recursively strips from nested objects", () => {
    const input = {
      name: "John",
      contact: { email: "john@example.com", phone: "555-123-4567" },
    };
    const result = stripPii(input);
    expect(result.contact.email).toBe("[EMAIL_REDACTED]");
    expect(result.contact.phone).toBe("[PHONE_REDACTED]");
  });

  it("strips from arrays", () => {
    const input = ["john@test.com", "safe text"];
    const result = stripPii(input);
    expect(result[0]).toBe("[EMAIL_REDACTED]");
    expect(result[1]).toBe("safe text");
  });

  it("does not mutate the original object", () => {
    const input = { email: "user@test.com" };
    const result = stripPii(input);
    expect(input.email).toBe("user@test.com");
    expect(result.email).toBe("[EMAIL_REDACTED]");
  });

  it("passes through non-PII strings unchanged", () => {
    expect(stripPii("hello world")).toBe("hello world");
  });

  it("passes through non-string primitives", () => {
    expect(stripPii(42)).toBe(42);
    expect(stripPii(true)).toBe(true);
    expect(stripPii(null)).toBe(null);
  });

  it("handles circular references without infinite loop", () => {
    const obj: Record<string, unknown> = { name: "user@test.com" };
    obj.self = obj;
    const result = stripPii(obj);
    expect(result.name).toBe("[EMAIL_REDACTED]");
    expect(result.self).toBe("[Circular]");
  });

  it("handles circular references in nested arrays", () => {
    const arr: unknown[] = ["user@test.com"];
    arr.push(arr);
    const result = stripPii(arr);
    expect(result[0]).toBe("[EMAIL_REDACTED]");
    expect(result[1]).toBe("[Circular]");
  });
});
