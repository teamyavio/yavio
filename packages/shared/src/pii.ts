/**
 * The string-level PII rules (#182): what one string becomes. Shared by the
 * SDK's best-effort stripper (packages/sdk/src/core/pii.ts, which bundles
 * this module) and ingest's authoritative one
 * (packages/ingest/src/lib/pii-stripper.ts). Each keeps its own walk over
 * objects and its own exemptions; the patterns live here once.
 *
 * What is matched, in this order:
 * 1. A string that is exactly a valid W3C traceparent is returned unchanged.
 * 2. Email addresses, over the whole string.
 * 3. UUID-shaped and traceparent-shaped tokens are masked: the next patterns
 *    run on the text between them, never inside them.
 * 4. Between the masked tokens: IBANs (mod-97 checked), card numbers (13-19
 *    digits, Luhn checked), US SSNs, US ITINs (ingest only), and phone
 *    numbers.
 * 5. US street addresses, over the whole string (ingest only).
 *
 * What is not matched (follow-ups): phone numbers grouped other than 3/4 + 3
 * + 4 digits, such as `030 12345678`, `+33 6 12 34 56 78` or `0171 123 45 67`,
 * and extensions (#189); 19-digit cards (#190); the SDK's spaced and bare
 * SSNs (#193); a number glued to a word of letters a-f only or to a token of
 * letters and digits (`cafe5551234567`), the price of not cutting hex ids
 * (see START). Wrongly matched: a standalone 10-digit number such as an epoch
 * second (#192), a 12-15-digit number that does not start with 1 (an EAN-13),
 * a Luhn-valid 13-19-digit number (#190), and IBAN-shaped hex (#191).
 */

/** Which stripper's rules apply. They differ only where they did before #182. */
export type PiiFlavor = "sdk" | "ingest";

export interface PiiStripResult {
  result: string;
  /** Whether at least one pattern replaced something. */
  redacted: boolean;
}

/**
 * Luhn algorithm: whether a digit string is a plausible card number. Keeps
 * digit runs that are not card numbers (years, order numbers) intact.
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

function passesCardCheck(match: string): boolean {
  const digits = match.replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(digits) && passesLuhn(digits);
}

/**
 * A valid W3C traceparent (#173), as the SDK stores it in a tool_call's
 * `metadata.traceparent`: `version-traceid-parentid-flags`, lower-case hex,
 * exactly 55 characters (§3.2.2), version not `ff` (§3.2.2.1), neither id
 * all zeros (§3.2.2.3, §3.2.2.4). `$` without the `m` flag: no trailing
 * newline either. Upper-case hex is invalid, and a higher version's extra
 * fields after the 55th character (§3.2.4) are not accepted.
 */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_PARENT_ID = "0".repeat(16);

/**
 * Whether the string is exactly a valid traceparent (format above). The one
 * check: the SDK's `traceparentOf()` and both strippers use it. A valid
 * value is 128 + 64 random bits and two bytes of hex, with no room for
 * personal data, so stripPiiString() returns it unchanged.
 */
export function isTraceparent(value: string): boolean {
  const match = TRACEPARENT.exec(value);
  return (
    match !== null && match[1] !== "ff" && match[2] !== ZERO_TRACE_ID && match[3] !== ZERO_PARENT_ID
  );
}

/**
 * Where a card, SSN, ITIN or phone number may start (#182). The digit run may
 * not follow a letter or digit, so the digits inside a hex id (`…b7ad6b7169203331`)
 * are not a number. One exception: it may follow a word of 1-24 letters only
 * (itself not glued to a letter or digit) that has a letter outside a-f,
 * so `Tel5551234567` and `card4111111111111111` are still redacted, while
 * `deadbeef5551234567` is a hex id. The leading lookahead keeps the
 * lookbehinds off every position that cannot start a number.
 */
const START =
  "(?=[\\d+(])(?:(?<![A-Za-z0-9])|(?<=(?<![A-Za-z0-9])(?=[A-Za-z]{0,23}[G-Zg-z])[A-Za-z]{1,24}))";
/** Where it must end: not followed by a letter or digit. */
const END = "(?![A-Za-z0-9])";

/**
 * UUIDs (any version, any letter case) and traceparent-shaped values (any
 * letter case, any version or ids), standing alone. The digit patterns never
 * run inside one: an all-digit UUID segment (`21165216-7349-4227-…`) is
 * neither a card nor a phone number.
 */
const ID_MASK =
  /(?<![A-Za-z0-9])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})(?![A-Za-z0-9])/gi;

interface Rule {
  pattern: RegExp;
  replacement: string;
  validate?: (match: string) => boolean;
}

// Bounded to the RFC 5321 limits (local part 64, domain 255): the unbounded
// `+` made the scan quadratic, and one size-limit-compliant batch could block
// the event loop for tens of seconds.
const EMAIL: Rule = {
  pattern: /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/g,
  replacement: "[EMAIL_REDACTED]",
};

// IBANs, compact or in groups of four (#90). Before the card and phone
// patterns, which would otherwise take only the digit tail and leave the
// country code, check digits and bank code in place.
const IBAN: Rule = {
  pattern: /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g,
  replacement: "[IBAN_REDACTED]",
  validate: passesIbanCheck,
};

// 13-19 digits with optional space or dash separators, Luhn checked.
const CARD: Rule = {
  pattern: new RegExp(`${START}(?:\\d[ -]*?){13,19}${END}`, "g"),
  replacement: "[CC_REDACTED]",
  validate: passesCardCheck,
};

// SDK: dashed SSNs only, any area number (aligning with ingest: #193).
const SSN_SDK: Rule = {
  pattern: new RegExp(`${START}\\d{3}-\\d{2}-\\d{4}${END}`, "g"),
  replacement: "[SSN_REDACTED]",
};

// Ingest: dashed, spaced and bare SSNs, without the never-issued area numbers
// 000, 666 and 900-999. The bare nine digits keep the `\b` boundaries they
// had before #182: on START/END, ids like `order_123456789` or `KD123456789`
// would be cut, so `ssn_123456789` stays unredacted as before.
const SSN_INGEST: Rule = {
  pattern: new RegExp(
    `${START}(?!000|666|9\\d{2})(?=\\d{3}[- ]|\\d{5}[- ])\\d{3}[- ]?\\d{2}[- ]?\\d{4}${END}|\\b(?!000|666|9\\d{2})\\d{9}\\b`,
    "g",
  ),
  replacement: "[SSN_REDACTED]",
};

// Ingest: US ITINs, 9XX-XX-XXXX, same token as an SSN. The bare form keeps
// its `\b` boundaries for the same reason as the SSN's.
const ITIN: Rule = {
  pattern: new RegExp(
    `${START}9(?=\\d{2}[- ]|\\d{4}[- ])\\d{2}[- ]?\\d{2}[- ]?\\d{4}${END}|\\b9\\d{8}\\b`,
    "g",
  ),
  replacement: "[SSN_REDACTED]",
};

// Phone numbers: an optional `+CC` or `00CC` and `(0)`, a first group of 3-4
// digits (so a trunk 0 or a leading 1 belongs to it: `0171 1234567`,
// `(0171) 1234567`, `15551234567`), then 3 and 4 digits, each group optionally
// separated by `-`, `.` or whitespace. Or a bare run of 12-15 digits that does
// not start with 1 (E.164 without the `+`: `491711234567`).
const PHONE: Rule = {
  pattern: new RegExp(
    `${START}(?:(?:\\+|00)\\d{1,3}[-.\\s]?(?:\\(0\\)[-.\\s]?)?)?\\(?\\d{3,4}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}${END}|${START}(?:0|[2-9])\\d{11,14}${END}`,
    "g",
  ),
  replacement: "[PHONE_REDACTED]",
};

/**
 * Common street type suffixes used for physical address detection.
 * Covers both full and abbreviated forms.
 */
const STREET_SUFFIXES =
  "Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Court|Ct|Place|Pl|Way|Circle|Cir|Terrace|Ter|Trail|Trl|Parkway|Pkwy|Highway|Hwy";

// Ingest: house number + street name + suffix (+ optional unit).
const ADDRESS: Rule = {
  pattern: new RegExp(
    `\\b\\d{1,6}\\s+[A-Z][a-zA-Z.]+(?:\\s+[A-Z][a-zA-Z.]+)*\\s+(?:${STREET_SUFFIXES})\\.?(?:\\s*(?:#|Apt\\.?|Suite|Ste\\.?|Unit)\\s*\\S+)?\\b`,
    "g",
  ),
  replacement: "[ADDRESS_REDACTED]",
};

const EMAIL_RULES: readonly Rule[] = [EMAIL];
const ADDRESS_RULES: readonly Rule[] = [ADDRESS];

/** The patterns that run between masked ids, in order, per flavor. */
const MASKED_RULES: Record<PiiFlavor, readonly Rule[]> = {
  sdk: [IBAN, CARD, SSN_SDK, PHONE],
  ingest: [IBAN, CARD, SSN_INGEST, ITIN, PHONE],
};

/**
 * Every pattern but the email one needs a digit, so text without one is
 * returned as it is: the same output, without the scans.
 */
const DIGIT = /\d/;

/** Each rule over the running result; a failed validation keeps the match. */
function applyRules(text: string, rules: readonly Rule[], hit: { redacted: boolean }): string {
  let result = text;
  for (const { pattern, replacement, validate } of rules) {
    result = result.replace(pattern, (match) => {
      if (validate && !validate(match)) return match;
      hit.redacted = true;
      return replacement;
    });
  }
  return result;
}

function applyToGap(text: string, rules: readonly Rule[], hit: { redacted: boolean }): string {
  return DIGIT.test(text) ? applyRules(text, rules, hit) : text;
}

/** The rules on the text between masked ids; the ids themselves stay verbatim. */
function applyBetweenIds(text: string, rules: readonly Rule[], hit: { redacted: boolean }): string {
  let out = "";
  let last = 0;
  // exec() on the module's regex, not matchAll(), which copies it per call.
  // Synchronous and never re-entered, so its lastIndex is ours.
  ID_MASK.lastIndex = 0;
  for (let id = ID_MASK.exec(text); id !== null; id = ID_MASK.exec(text)) {
    out += applyToGap(text.slice(last, id.index), rules, hit) + id[0];
    last = ID_MASK.lastIndex;
  }
  // A masked id is never empty, so last === 0 means there was none.
  return last === 0 ? applyRules(text, rules, hit) : out + applyToGap(text.slice(last), rules, hit);
}

/**
 * Strip PII from one string with the given flavor's rules (see the module
 * comment for what they match). The replacement tokens are `[EMAIL_REDACTED]`,
 * `[IBAN_REDACTED]`, `[CC_REDACTED]`, `[SSN_REDACTED]` (SSNs and ITINs),
 * `[PHONE_REDACTED]` and `[ADDRESS_REDACTED]`.
 */
export function stripPiiString(value: string, flavor: PiiFlavor): PiiStripResult {
  if (isTraceparent(value)) return { result: value, redacted: false };
  const hit = { redacted: false };
  // Without an "@" the email pattern cannot match: skipping it changes no
  // output and saves its scan, the slowest of all on long text.
  let result = value.includes("@") ? applyRules(value, EMAIL_RULES, hit) : value;
  if (!DIGIT.test(result)) return { result, redacted: hit.redacted };
  result = applyBetweenIds(result, MASKED_RULES[flavor], hit);
  if (flavor === "ingest") result = applyRules(result, ADDRESS_RULES, hit);
  return { result, redacted: hit.redacted };
}
