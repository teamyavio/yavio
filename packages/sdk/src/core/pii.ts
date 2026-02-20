/**
 * Client-side best-effort PII stripping.
 *
 * Recursively walks all string values and replaces patterns matching
 * common PII: emails, credit cards, SSNs, phone numbers.
 * Zero dependencies. Not configurable. Defense-in-depth layer
 * (the ingestion API performs authoritative stripping).
 */

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[EMAIL_REDACTED]",
  },
  {
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: "[CC_REDACTED]",
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
  for (const { pattern, replacement } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
    }
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
