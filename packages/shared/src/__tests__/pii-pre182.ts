/**
 * Test oracle: the string functions of the two PII strippers as they were at
 * a7bbe0e (SDK 0.5.5, packages/sdk/src/core/pii.ts, and the ingest of that
 * commit, packages/ingest/src/lib/pii-stripper.ts), copied verbatim apart
 * from the shared helpers. Without regex lookbehind, @yavio/shared/pii must
 * strip exactly like this (#182 review round 1). Do not "fix" it.
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

const isCard = (match: string) => {
  const digits = match.replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(digits) && passesLuhn(digits);
};

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
function isTraceparent(value: string): boolean {
  const match = TRACEPARENT.exec(value);
  return (
    match !== null &&
    match[1] !== "ff" &&
    match[2] !== "0".repeat(32) &&
    match[3] !== "0".repeat(16)
  );
}

type Pattern = { pattern: RegExp; replacement: string; validate?: (match: string) => boolean };

const EMAIL: Pattern = {
  pattern: /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/g,
  replacement: "[EMAIL_REDACTED]",
};
const IBAN: Pattern = {
  pattern: /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g,
  replacement: "[IBAN_REDACTED]",
  validate: passesIbanCheck,
};
const PHONE: Pattern = {
  pattern: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  replacement: "[PHONE_REDACTED]",
};
const STREET_SUFFIXES =
  "Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Court|Ct|Place|Pl|Way|Circle|Cir|Terrace|Ter|Trail|Trl|Parkway|Pkwy|Highway|Hwy";

const SDK_PATTERNS: Pattern[] = [
  EMAIL,
  IBAN,
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: "[CC_REDACTED]", validate: isCard },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN_REDACTED]" },
  PHONE,
];

const INGEST_PATTERNS: Pattern[] = [
  EMAIL,
  IBAN,
  { pattern: /\b(\d[ -]*?){13,19}\b/g, replacement: "[CC_REDACTED]", validate: isCard },
  { pattern: /\b(?!000|666|9\d{2})\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, replacement: "[SSN_REDACTED]" },
  { pattern: /\b9\d{2}[- ]?\d{2}[- ]?\d{4}\b/g, replacement: "[SSN_REDACTED]" },
  PHONE,
  {
    pattern: new RegExp(
      `\\b\\d{1,6}\\s+[A-Z][a-zA-Z.]+(?:\\s+[A-Z][a-zA-Z.]+)*\\s+(?:${STREET_SUFFIXES})\\.?(?:\\s*(?:#|Apt\\.?|Suite|Ste\\.?|Unit)\\s*\\S+)?\\b`,
      "g",
    ),
    replacement: "[ADDRESS_REDACTED]",
  },
];

/** SDK 0.5.5's stripPiiFromString. */
export function sdkPre182(value: string): string {
  if (isTraceparent(value)) return value;
  let result = value;
  for (const { pattern, replacement, validate } of SDK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) =>
      validate && !validate(match) ? match : replacement,
    );
  }
  return result;
}

/** The pre-#182 ingest's stripPiiFromString. */
export function ingestPre182(value: string): { result: string; redacted: boolean } {
  if (isTraceparent(value)) return { result: value, redacted: false };
  let result = value;
  let redacted = false;
  for (const { pattern, replacement, validate } of INGEST_PATTERNS) {
    pattern.lastIndex = 0;
    if (validate) {
      result = result.replace(pattern, (match) => {
        if (validate(match)) {
          redacted = true;
          return replacement;
        }
        return match;
      });
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
