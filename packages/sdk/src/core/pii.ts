/**
 * Client-side best-effort PII stripping.
 *
 * Recursively walks all string values and replaces patterns matching
 * common PII: emails, credit cards, SSNs, phone numbers.
 * Zero dependencies. Not configurable. Defense-in-depth layer
 * (the ingestion API performs authoritative stripping).
 */

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
