import { describe, expect, it } from "vitest";
import { stripPii } from "../core/pii.js";

describe("stripPii", () => {
  it("redacts email addresses", () => {
    expect(stripPii("contact user@example.com")).toBe("contact [EMAIL_REDACTED]");
  });

  it("redacts credit card numbers", () => {
    expect(stripPii("card 4111 1111 1111 1111")).toBe("card [CC_REDACTED]");
  });

  it("scans long benign strings in linear time", () => {
    // Guards against reintroducing the quadratic email scan (was seconds
    // for 32 KB of plain text inside the customer's own server process).
    const start = performance.now();
    stripPii("a".repeat(32_000));
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("keeps non-Luhn digit runs like year lists intact", () => {
    // Mirrors the ingest stripper: only Luhn-valid runs are card numbers
    const text = "Comparing revenue for 2022 2023 2024 2025 to build the yearly summary";
    expect(stripPii(text)).toBe(text);
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

describe("IBAN (#90)", () => {
  it.each(["DE89370400440532013000", "DE89 3704 0044 0532 0130 00", "GB82 WEST 1234 5698 7654 32"])(
    "redacts the whole IBAN %s",
    (iban) => {
      expect(stripPii(`IBAN ${iban}.`)).toBe("IBAN [IBAN_REDACTED].");
    },
  );

  it("does not redact a wrong check digit as an IBAN", () => {
    expect(stripPii("DE89370400440532013001")).not.toContain("[IBAN_REDACTED]");
  });

  it("leaves IBAN-shaped plain text alone", () => {
    expect(stripPii("AB12 test case data here")).toBe("AB12 test case data here");
  });

  it("strips IBANs inside intent-like nested text", () => {
    expect(stripPii({ note: "send to DE89370400440532013000 by friday" })).toEqual({
      note: "send to [IBAN_REDACTED] by friday",
    });
  });
});

describe("a W3C traceparent (#173)", () => {
  // The W3C example's parent id ends in ten decimal digits, which the
  // phone pattern took for a number (`…-b7ad6b[PHONE_REDACTED]-01`); about
  // 1.9 % of random traceparents do.
  it("leaves a valid W3C traceparent alone", () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    expect(stripPii({ traceparent })).toEqual({ traceparent });
  });

  it("strips the text around a traceparent-shaped value, never the value itself (#182)", () => {
    // Only the exact, valid format is exempt as a whole string. A
    // traceparent-shaped value inside text, or an invalid one, is masked
    // instead: the patterns run around it, so the phone number is redacted
    // and the hex ids are not cut (before #182: `…-b7ad6b[PHONE_REDACTED]-01`).
    const text = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01 call 555-123-4567";
    expect(stripPii(text)).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01 call [PHONE_REDACTED]",
    );
    // Upper-case hex is not a valid traceparent (W3C §3.2.2), but it is one's shape.
    expect(stripPii("00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01")).toBe(
      "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01",
    );
    // Version ff is invalid (§3.2.2.1), but it is one's shape too.
    expect(stripPii("ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBe(
      "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
  });
});

describe("ids and the digit patterns (#182)", () => {
  // The phone pattern had no leading boundary: it took the last ten decimal
  // digits of a hex run, 1.8 % of random UUIDs. The card pattern took the
  // all-digit segments of a UUID. The full corpus is in
  // packages/shared/src/__tests__/pii-ids.test.ts.
  it("leaves UUIDs and hex ids in nested input alone, and still strips PII next to them", () => {
    const input = {
      order: "47e16ee3-3d22-430b-acb1-959114949231",
      upper: "21165216-7349-4227-981E-DF7D3BF851DC",
      hex: "b7ad6b7169203331",
      note: "47e16ee3-3d22-430b-acb1-959114949231 call 0171-1234567",
    };
    expect(stripPii(input)).toEqual({
      ...input,
      note: "47e16ee3-3d22-430b-acb1-959114949231 call [PHONE_REDACTED]",
    });
  });
});
