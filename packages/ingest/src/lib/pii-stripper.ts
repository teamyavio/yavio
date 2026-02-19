/**
 * PII stripping engine.
 *
 * Recursively walks all string values in an object and replaces
 * patterns matching common PII: emails, credit cards, SSNs, phone numbers,
 * and physical addresses.
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
  // Email addresses
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[EMAIL_REDACTED]",
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
 * Strip PII patterns from a single string value.
 */
export function stripPiiFromString(value: string): { result: string; redacted: boolean } {
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
 * Recursively strip PII from all string values in an object.
 * Returns a new object (does not mutate the original).
 */
export function stripPii<T>(data: T): { result: T; piiDetected: boolean } {
  let piiDetected = false;

  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      const { result, redacted } = stripPiiFromString(value);
      if (redacted) piiDetected = true;
      return result;
    }

    if (Array.isArray(value)) {
      return value.map(walk);
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = walk(val);
      }
      return result;
    }

    return value;
  }

  const result = walk(data) as T;
  return { result, piiDetected };
}
