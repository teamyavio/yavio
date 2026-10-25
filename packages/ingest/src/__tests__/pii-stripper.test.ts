import { describe, expect, it } from "vitest";
import { EVENT_IDENTIFIER_FIELDS, stripPii, stripPiiFromString } from "../lib/pii-stripper.js";

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

describe("pathological input performance", () => {
  it("scans long benign strings in linear time", () => {
    // The unbounded email local-part made this quadratic: 32 KB of plain
    // text took multiple SECONDS, letting one size-limit-compliant batch
    // block the ingest event loop. Bounded pattern: ~45ms. The generous
    // threshold only guards against reintroducing the quadratic scan.
    const benign = "a".repeat(32_000);
    const start = performance.now();
    const { redacted } = stripPiiFromString(benign);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(redacted).toBe(false);
  });

  it("still redacts an email with the RFC-maximum 64-char local part", () => {
    const email = `${"l".repeat(64)}@example.com`;
    const { result } = stripPiiFromString(`mail ${email} end`);
    expect(result).toBe("mail [EMAIL_REDACTED] end");
  });
});

describe("IBAN (#90)", () => {
  it.each([
    "DE89370400440532013000",
    "DE89 3704 0044 0532 0130 00",
    "GB82 WEST 1234 5698 7654 32",
    "NL91ABNA0417164300",
    "de89370400440532013000",
  ])("redacts the whole IBAN %s", (iban) => {
    const { result, redacted } = stripPiiFromString(`pay to ${iban} please`);
    expect(result).toBe("pay to [IBAN_REDACTED] please");
    expect(redacted).toBe(true);
  });

  it("does not redact a string with a wrong check digit as an IBAN", () => {
    const { result } = stripPiiFromString("DE89370400440532013001");
    expect(result).not.toContain("[IBAN_REDACTED]");
  });

  it("leaves IBAN-shaped plain text alone", () => {
    expect(stripPiiFromString("AB12 test case data here").result).toBe("AB12 test case data here");
  });
});

describe("identifier fields are not stripped (#90)", () => {
  // Found in CI: a random UUID ending in a phone-shaped digit run was stored
  // as ...-95[PHONE_REDACTED], so the event could not be found by its id.
  const event = {
    event_id: "47e16ee3-3d22-430b-acb1-959114949231",
    trace_id: "tr_4155550134",
    session_id: "a83947291834ab5550134",
    subject_id: "v1/415-555-0134",
    timestamp: "2026-10-14T12:00:00.000Z",
    event_name: "quote_jane@example.com",
    user_id: "jane@example.com",
    metadata: { session_id: "555 123 4567" },
  };

  it("keeps ids and timestamp verbatim, strips everything else", () => {
    const { result } = stripPii([event], { exemptEventKeys: EVENT_IDENTIFIER_FIELDS });
    const [out] = result;
    expect(out.event_id).toBe(event.event_id);
    expect(out.trace_id).toBe(event.trace_id);
    expect(out.session_id).toBe(event.session_id);
    expect(out.subject_id).toBe(event.subject_id);
    expect(out.timestamp).toBe(event.timestamp);
    // Content is still stripped — including a nested key that happens to be
    // called session_id, and user_id, which integrators may set to an email.
    expect(out.event_name).toBe("[EMAIL_REDACTED]");
    expect(out.user_id).toBe("[EMAIL_REDACTED]");
    expect(out.metadata.session_id).toBe("[PHONE_REDACTED]");
  });

  it("strips ids too when no exemption is passed (the old behaviour)", () => {
    const { result } = stripPii([event]);
    expect(result[0].event_id).toContain("[PHONE_REDACTED]");
  });
});

describe("a W3C traceparent (#173)", () => {
  // The W3C Trace Context example. Its parent id ends in ten decimal digits,
  // which the phone pattern took for a number; about 1.9 % of random valid
  // traceparents do. The SDK stores one as a tool_call's metadata.traceparent.
  const W3C = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

  it("leaves a string that is exactly a valid traceparent unchanged, not redacted", () => {
    expect(stripPiiFromString(W3C)).toEqual({ result: W3C, redacted: false });
    const { result, piiDetected } = stripPii([{ metadata: { traceparent: W3C } }]);
    expect(result[0].metadata.traceparent).toBe(W3C);
    expect(piiDetected).toBe(false);
  });

  it.each([
    ["text around one", `${W3C} call 555-123-4567`],
    ["upper-case hex", W3C.toUpperCase()],
    ["version ff", `ff${W3C.slice(2)}`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-b7ad6b7169203331-01`],
    ["an all-zero parent id", `00-0af7651916cd43dd8448eb2155501340-${"0".repeat(16)}-01`],
    ["a higher version's extra field", `01${W3C.slice(2)}-00`],
    ["a trailing newline", `${W3C}\n`],
  ])("strips %s as before: the exemption is for the exact format only", (_case, value) => {
    const { result, redacted } = stripPiiFromString(value);
    expect(result).toContain("[PHONE_REDACTED]");
    expect(redacted).toBe(true);
  });
});
