import { describe, expect, it } from "vitest";
import { stripPii, stripPiiFromString } from "../lib/pii-stripper.js";

describe("stripPiiFromString", () => {
  it("redacts email addresses", () => {
    const { result, redacted } = stripPiiFromString("Contact user@example.com for info");
    expect(result).toBe("Contact [EMAIL_REDACTED] for info");
    expect(redacted).toBe(true);
  });

  it("redacts multiple emails", () => {
    const { result } = stripPiiFromString("a@b.com and c@d.org");
    expect(result).toBe("[EMAIL_REDACTED] and [EMAIL_REDACTED]");
  });

  it("redacts US SSN with dashes", () => {
    const { result, redacted } = stripPiiFromString("SSN: 123-45-6789");
    expect(result).toBe("SSN: [SSN_REDACTED]");
    expect(redacted).toBe(true);
  });

  it("redacts US SSN with spaces", () => {
    const { result } = stripPiiFromString("SSN: 123 45 6789");
    expect(result).toContain("[SSN_REDACTED]");
  });

  it("redacts US SSN without separators", () => {
    const { result } = stripPiiFromString("SSN: 123456789");
    expect(result).toContain("[SSN_REDACTED]");
  });

  it("does not redact invalid SSN area numbers (000, 666)", () => {
    expect(stripPiiFromString("000-12-3456").result).not.toContain("[SSN_REDACTED]");
    expect(stripPiiFromString("666-12-3456").result).not.toContain("[SSN_REDACTED]");
  });

  it("redacts ITIN numbers (9XX-XX-XXXX)", () => {
    const { result } = stripPiiFromString("ITIN: 912-34-5678");
    expect(result).toContain("[SSN_REDACTED]");
  });

  it("redacts phone numbers", () => {
    const { result } = stripPiiFromString("Call (555) 123-4567");
    expect(result).toContain("[PHONE_REDACTED]");
  });

  it("redacts international phone numbers", () => {
    const { result } = stripPiiFromString("Call +1-555-123-4567");
    expect(result).toContain("[PHONE_REDACTED]");
  });

  it("redacts credit card numbers passing Luhn check", () => {
    // 4111 1111 1111 1111 is a valid Visa test number (passes Luhn)
    const { result } = stripPiiFromString("Card: 4111 1111 1111 1111");
    expect(result).toContain("[CC_REDACTED]");
  });

  it("redacts credit card with dashes", () => {
    const { result } = stripPiiFromString("Card: 4111-1111-1111-1111");
    expect(result).toContain("[CC_REDACTED]");
  });

  it("does not redact numeric sequences that fail Luhn", () => {
    // 1234567890123 does not pass Luhn — should not be redacted
    const { result } = stripPiiFromString("ID: 1234567890123");
    expect(result).not.toContain("[CC_REDACTED]");
  });

  it("redacts physical addresses", () => {
    const { result, redacted } = stripPiiFromString("Lives at 123 Main Street");
    expect(result).toContain("[ADDRESS_REDACTED]");
    expect(redacted).toBe(true);
  });

  it("redacts addresses with multi-word street names", () => {
    const { result } = stripPiiFromString("Office: 456 Oak Park Boulevard");
    expect(result).toContain("[ADDRESS_REDACTED]");
  });

  it("redacts addresses with abbreviated suffixes", () => {
    const { result } = stripPiiFromString("Send to 789 Elm Dr");
    expect(result).toContain("[ADDRESS_REDACTED]");
  });

  it("redacts addresses with unit numbers", () => {
    const { result } = stripPiiFromString("Ship to 100 Pine Ave Apt 4B");
    expect(result).toContain("[ADDRESS_REDACTED]");
  });

  it("does not redact non-address text", () => {
    const { result } = stripPiiFromString("Processed 500 events today");
    expect(result).not.toContain("[ADDRESS_REDACTED]");
  });

  it("returns original string when no PII found", () => {
    const { result, redacted } = stripPiiFromString("No PII here at all");
    expect(result).toBe("No PII here at all");
    expect(redacted).toBe(false);
  });
});

describe("stripPii (recursive)", () => {
  it("strips PII from nested object strings", () => {
    const data = {
      name: "test",
      contact: {
        email: "user@example.com",
        phone: "(555) 123-4567",
      },
    };
    const { result, piiDetected } = stripPii(data);
    expect(result.contact.email).toBe("[EMAIL_REDACTED]");
    expect(result.contact.phone).toContain("[PHONE_REDACTED]");
    expect(piiDetected).toBe(true);
  });

  it("strips PII from arrays", () => {
    const data = ["user@example.com", "no-pii", "123-45-6789"];
    const { result } = stripPii(data);
    expect(result[0]).toBe("[EMAIL_REDACTED]");
    expect(result[1]).toBe("no-pii");
    expect(result[2]).toBe("[SSN_REDACTED]");
  });

  it("preserves non-string values", () => {
    const data = { count: 42, active: true, tags: null };
    const { result, piiDetected } = stripPii(data);
    expect(result).toEqual(data);
    expect(piiDetected).toBe(false);
  });

  it("handles deeply nested objects", () => {
    const data = { a: { b: { c: { email: "test@test.com" } } } };
    const { result } = stripPii(data);
    expect(result.a.b.c.email).toBe("[EMAIL_REDACTED]");
  });

  it("does not mutate the original object", () => {
    const data = { email: "user@example.com" };
    stripPii(data);
    expect(data.email).toBe("user@example.com");
  });

  it("handles empty objects", () => {
    const { result, piiDetected } = stripPii({});
    expect(result).toEqual({});
    expect(piiDetected).toBe(false);
  });
});
