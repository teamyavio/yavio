/**
 * Client-side best-effort PII stripping.
 *
 * Recursively walks all string values and replaces patterns matching
 * common PII: emails, IBANs, credit cards, SSNs, phone numbers.
 * Zero dependencies. Not configurable. Defense-in-depth layer
 * (the ingestion API performs authoritative stripping).
 */

import { traceparentOf } from "./trace-context.js";

/**
 * Luhn algorithm — validates that a digit string is a plausible credit card
 * number. Mirrors the ingest-side stripper so this layer never redacts digit
 * runs (years, order numbers) that the authoritative layer would preserve.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number.parseInt(digits[i] as string, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * ISO 13616 IBAN check (mod 97 = 1), mirroring the ingest-side stripper (#90).
 * Intent text is stripped here, before it leaves the integrator's server.
 */
function passesIbanCheck(candidate: string): boolean {
  const iban = candidate.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  if ((iban.slice(4).match(/\d/g) ?? []).length < 8) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

const PII_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string;
  validate?: (match: string) => boolean;
}> = [
  // Bounded to RFC 5321 limits — the unbounded local part made scanning
  // quadratic on long benign strings (mirrors the ingest-side stripper).
  {
    pattern: /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/g,
    replacement: "[EMAIL_REDACTED]",
  },
  // IBANs, compact or grouped. Before the card and phone patterns, which
  // would otherwise take only the digit tail.
  {
    pattern: /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g,
    replacement: "[IBAN_REDACTED]",
    validate: passesIbanCheck,
  },
  {
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: "[CC_REDACTED]",
    validate: (match: string) => {
      const digits = match.replace(/[\s-]/g, "");
      return /^\d{13,19}$/.test(digits) && passesLuhn(digits);
    },
  },
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
  {
    pattern: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[PHONE_REDACTED]",
  },
];

function stripPiiFromString(value: string): string {
  // A valid W3C traceparent (#173) is random hex in a fixed format and cannot
  // hold PII, but its 32- and 16-digit ids end in ten decimal digits often
  // enough (~1.9 %, the spec's own example among them) for the phone pattern
  // to cut them: `…-b7ad6b[PHONE_REDACTED]-01`. Mirrored in ingest.
  if (traceparentOf(value)) return value;
  let result = value;
  for (const { pattern, replacement, validate } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) =>
      validate && !validate(match) ? match : replacement,
    );
  }
  return result;
}

/** Recursively strip PII from all string values. Returns a new object. */
export function stripPii<T>(data: T): T {
  const seen = new WeakSet();

  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      return stripPiiFromString(value);
    }
    if (value !== null && typeof value === "object") {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);

      if (Array.isArray(value)) {
        return value.map(walk);
      }
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = walk(val);
      }
      return result;
    }
    return value;
  }

  return walk(data) as T;
}
