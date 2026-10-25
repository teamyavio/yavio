/**
 * PII stripping engine.
 *
 * Recursively walks all string values in an object and replaces
 * patterns matching common PII: emails, IBANs, credit cards, SSNs, phone
 * numbers, and physical addresses.
 */

/**
 * Luhn algorithm — validates that a digit string is a plausible credit card number.
 * Filters out random numeric sequences that happen to be 13-19 digits.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number.parseInt(digits[i], 10);
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
 * ISO 13616 IBAN check: move the first four characters to the end, map
 * letters to 10..35, and the number mod 97 must be 1. Filters out random
 * letter/digit strings of the right shape (#90).
 */
function passesIbanCheck(candidate: string): boolean {
  const iban = candidate.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  // Real BBANs are mostly digits (even GB/NL, whose bank codes are letters).
  // Plain text like "AB12 test case data here" has the shape but no digits.
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

/**
 * Common street type suffixes used for physical address detection.
 * Covers both full and abbreviated forms.
 */
const STREET_SUFFIXES =
  "Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Court|Ct|Place|Pl|Way|Circle|Cir|Terrace|Ter|Trail|Trl|Parkway|Pkwy|Highway|Hwy";

// Patterns ordered from most specific to least specific
const PII_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string;
  validate?: (match: string) => boolean;
}> = [
  // Email addresses. Quantifiers are bounded to the RFC 5321 limits (local
  // part 64, domain 255): the unbounded `+` made the scan quadratic — every
  // position in a long benign string consumed to the end before failing at
  // the `@` — letting one size-limit-compliant batch block the event loop
  // for tens of seconds.
  {
    pattern: /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/g,
    replacement: "[EMAIL_REDACTED]",
  },
  // IBANs, compact or in groups of four (#90). Before the card and phone
  // patterns: those used to take the digit tail and leave the country code,
  // check digits and bank code in place (DE8937040044[PHONE_REDACTED]).
  {
    pattern: /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g,
    replacement: "[IBAN_REDACTED]",
    validate: passesIbanCheck,
  },
  // Credit card numbers (13-19 digits with optional space/dash separators, Luhn-validated)
  {
    pattern: /\b(\d[ -]*?){13,19}\b/g,
    replacement: "[CC_REDACTED]",
    validate: (match: string) => {
      const digits = match.replace(/[\s-]/g, "");
      return /^\d{13,19}$/.test(digits) && passesLuhn(digits);
    },
  },
  // US Social Security Numbers — dashed, spaced, and contiguous variants
  // Excludes known-invalid ranges: 000, 666, 900-999 in area number
  {
    pattern: /\b(?!000|666|9\d{2})\d{3}[- ]?\d{2}[- ]?\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
  // US Individual Taxpayer Identification Numbers (ITINs): 9XX-XX-XXXX
  {
    pattern: /\b9\d{2}[- ]?\d{2}[- ]?\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
  // Phone numbers (international and US formats)
  {
    pattern: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[PHONE_REDACTED]",
  },
  // Physical addresses: house number + street name + suffix (+ optional unit)
  {
    pattern: new RegExp(
      `\\b\\d{1,6}\\s+[A-Z][a-zA-Z.]+(?:\\s+[A-Z][a-zA-Z.]+)*\\s+(?:${STREET_SUFFIXES})\\.?(?:\\s*(?:#|Apt\\.?|Suite|Ste\\.?|Unit)\\s*\\S+)?\\b`,
      "g",
    ),
    replacement: "[ADDRESS_REDACTED]",
  },
];

/**
 * A valid W3C traceparent (#173), as the SDK stores it in a tool_call's
 * `metadata.traceparent`: `version-traceid-parentid-flags`, lower-case hex,
 * exactly 55 characters, version not `ff`, neither id all zeros. Random hex
 * in a fixed layout, no room for PII, but its ids end in ten decimal digits
 * often enough (~1.9 %, the W3C example among them) for the phone pattern to
 * cut them (`…-b7ad6b[PHONE_REDACTED]-01`). Exactly the format, never a
 * string that merely contains one. Mirrors the SDK's `traceparentOf()`
 * (packages/sdk/src/core/trace-context.ts).
 */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_PARENT_ID = "0".repeat(16);

function isTraceparent(value: string): boolean {
  const match = TRACEPARENT.exec(value);
  return (
    match !== null && match[1] !== "ff" && match[2] !== ZERO_TRACE_ID && match[3] !== ZERO_PARENT_ID
  );
}

/**
 * Strip PII patterns from a single string value. A valid traceparent is
 * returned unchanged (see isTraceparent).
 */
export function stripPiiFromString(value: string): { result: string; redacted: boolean } {
  if (isTraceparent(value)) return { result: value, redacted: false };
  let result = value;
  let redacted = false;

  for (const { pattern, replacement, validate } of PII_PATTERNS) {
    pattern.lastIndex = 0;

    if (validate) {
      // Replace only matches that pass the validation function
      const next = result.replace(pattern, (match) => {
        if (validate(match)) {
          redacted = true;
          return replacement;
        }
        return match;
      });
      result = next;
    } else {
      pattern.lastIndex = 0;
      if (pattern.test(result)) {
        redacted = true;
        pattern.lastIndex = 0;
        result = result.replace(pattern, replacement);
      }
    }
  }

  return { result, redacted };
}

/**
 * Event fields that hold identifiers or validated formats, never user content.
 *
 * The patterns must not run over them: a random UUID or a hex session hash
 * that happens to contain a digit run was rewritten (an event_id ending in
 * -959114949231 was stored as -95[PHONE_REDACTED]), which corrupts the id,
 * breaks joins on trace/session, and can make two events collide on one
 * event_id. `user_id` is not listed: integrators choose it, and some use an
 * email address.
 */
export const EVENT_IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  "event_id",
  "trace_id",
  "session_id",
  "subject_id",
  "timestamp",
]);

export interface StripPiiOptions {
  /** Keys left untouched on each object directly inside the top-level array. */
  exemptEventKeys?: ReadonlySet<string>;
}

/**
 * Recursively strip PII from all string values in an object.
 * Returns a new object (does not mutate the original).
 */
export function stripPii<T>(
  data: T,
  options: StripPiiOptions = {},
): { result: T; piiDetected: boolean } {
  let piiDetected = false;
  const exempt = options.exemptEventKeys;

  function walk(value: unknown, depth: number): unknown {
    if (typeof value === "string") {
      const { result, redacted } = stripPiiFromString(value);
      if (redacted) piiDetected = true;
      return result;
    }

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        // depth 1: an event inside the top-level batch array.
        result[key] = exempt && depth === 1 && exempt.has(key) ? val : walk(val, depth + 1);
      }
      return result;
    }

    return value;
  }

  const result = walk(data, 0) as T;
  return { result, piiDetected };
}
