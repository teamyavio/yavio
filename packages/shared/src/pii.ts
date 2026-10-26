/**
 * The string-level PII rules (#182): what one string becomes. Shared by the
 * SDK's best-effort stripper (packages/sdk/src/core/pii.ts, which bundles
 * this module, also into the React widget) and ingest's authoritative one
 * (packages/ingest/src/lib/pii-stripper.ts). Each keeps its own walk over
 * objects and its own exemptions; the patterns live here once.
 *
 * What is matched, in this order:
 * 1. A string that is exactly a valid W3C traceparent is returned unchanged.
 * 2. Email addresses, over the whole string.
 * 3. UUID-shaped and traceparent-shaped tokens standing alone are masked: the
 *    next patterns run on the text between them, never inside them.
 * 4. Between the masked tokens: IBANs (mod-97 checked), card numbers (13-19
 *    digits, Luhn checked), US SSNs, US ITINs (ingest only), and phone
 *    numbers.
 * 5. US street addresses, over the whole string (ingest only).
 *
 * What is not matched (follow-ups): phone numbers grouped other than 3/4/5 +
 * 3 + 4 digits, such as `030 12345678`, `+33 6 12 34 56 78`, `0171 123 45 67`
 * or `07700 900 123`, a `/` between groups, and extensions (#189); 19-digit
 * cards and cards grouped with other spaces (no-break spaces), and a
 * Luhn-invalid card in groups (`4111 1111 1111 1112`; #190); the SDK's spaced
 * and bare SSNs (#193); in ingest, a bare or one-separator SSN/ITIN after a
 * `\u00a0`-style escape (A1); a phone number glued to a word of letters a-f
 * only unless it has a phone's shape (`cafe5551234567`), a Luhn-invalid
 * 16-digit run glued to one (`cafe4111111111111112`), a number glued to a
 * token of letters and digits (`ref15551234567`) or to a word of more than
 * 24 letters: the price of not cutting hex ids (see START). Wrongly matched:
 * a standalone 10-digit number such as an epoch second (#192), a
 * 12-15-digit number that does not start with 1 (an EAN-13), any 16 digits
 * in a row (an epoch in microseconds) and a Luhn-valid 13-19-digit number
 * (#190), IBAN-shaped hex (#191), a fully separated SSN glued to a word
 * (`XBG109-09-1527`), a word glued to a number after an escape (an encoded
 * path, `%2Fuser1234567890`), and an escape's own digits taken into a number
 * (`%20` + `5551234567` becomes `%[PHONE_REDACTED]`; a Luhn-valid card run
 * starting inside a `\u` escape leaves the card's last group: see
 * applyRetrying for why that start is not forbidden).
 *
 * No regular expression with a lookbehind is written as a literal: a browser
 * without lookbehind support (Safari and iOS before 16.4) would fail to parse
 * the whole bundle. They are compiled on first use, and where that throws, the
 * pre-#182 patterns (no lookbehind, no mask) take over: they cut more ids but
 * redact nothing less than SDK 0.5.5 did (see legacyEngine).
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

const EMAIL_TOKEN = "[EMAIL_REDACTED]";
const IBAN_TOKEN = "[IBAN_REDACTED]";
const CARD_TOKEN = "[CC_REDACTED]";
const SSN_TOKEN = "[SSN_REDACTED]";
const PHONE_TOKEN = "[PHONE_REDACTED]";
const ADDRESS_TOKEN = "[ADDRESS_REDACTED]";

// Regex sources, compiled in currentEngine(). Never literals: see the module
// comment.

/** Not directly after a letter or digit. */
const NOT_GLUED = String.raw`(?<![A-Za-z0-9])`;
/**
 * Right after a URL percent-escape (`%2B4917612345678`, `Call%20me%20at%20...`),
 * a JSON `\uXXXX` escape (`"Tel.\u00a00171 1234567"` from an ensure_ascii
 * encoder) or a JSON letter escape (`"Jane\f5551234567"`): the escape ends in a
 * letter or hex digit glued to what follows.
 */
const AFTER_ESCAPE = [
  String.raw`(?<=%[0-9A-Fa-f]{2})`,
  // A double-encoded one, `%252B4917612345678` (review round 3).
  String.raw`(?<=%25[0-9A-Fa-f]{2})`,
  String.raw`(?<=\\u[0-9A-Fa-f]{4})`,
  String.raw`(?<=\\[bfnrt])`,
];
/** Not glued to a letter or digit, or right after an escape. */
const STANDALONE = `(?:${[NOT_GLUED, ...AFTER_ESCAPE].join("|")})`;

/**
 * Where a card, SSN, ITIN or phone number may start (#182). The digit run may
 * not follow a letter or digit, so the digits inside a hex id (`…b7ad6b7169203331`)
 * are not a number. It may still follow:
 * - a word of 1-24 letters only that has a letter outside a-f, the word
 *   itself standing alone or right after an escape: `Tel5551234567`,
 *   `card4111111111111111`, `Call%20me%20at%20Tel5551234567`;
 * - an escape (AFTER_ESCAPE);
 * - a word of letters a-f only, standing alone or right after an escape, when
 *   the number has a phone's shape: a `+`, a `(`, or a separator after its
 *   first 2-4 digits (`cafe555-123-4567`), which a hex id never has
 *   (`deadbeef5551234567` stays).
 * The leading lookahead keeps the lookbehinds off every position that cannot
 * start a number.
 */
const START = `(?=[\\d+(])(?:${[
  NOT_GLUED,
  String.raw`(?<=${STANDALONE}(?=[A-Za-z]{0,23}[G-Zg-z])[A-Za-z]{1,24})`,
  ...AFTER_ESCAPE,
  String.raw`(?<=${STANDALONE}[A-Fa-f]{1,24})(?=[+(]|\d{2,4}\)?[-.\s])`,
].join("|")})`;
/**
 * Where a card number may start: as START, but after any word of 1-24 letters
 * only, a-f included and without a phone's shape (`cafe4367063062371650`,
 * `a4666960593450200`). Luhn already tells a card from a hex id there (review
 * round 3).
 */
const START_CARD = `(?=[\\d+(])(?:${[
  NOT_GLUED,
  String.raw`(?<=${STANDALONE}[A-Za-z]{1,24})`,
  ...AFTER_ESCAPE,
].join("|")})`;
/** Where it must end: not followed by a letter or digit. */
const END = "(?![A-Za-z0-9])";

/**
 * UUIDs (any version, any letter case) and traceparent-shaped values (any
 * letter case, any version or ids), standing alone or right after an escape
 * (`%2F<uuid>`). The digit patterns never run inside one: an all-digit UUID
 * segment (`21165216-7349-4227-…`) is neither a card nor a phone number.
 */
const ID_MASK = `${STANDALONE}(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})(?![A-Za-z0-9])`;

interface Rule {
  pattern: RegExp;
  replacement: string;
  validate?: (match: string) => boolean;
  /**
   * A candidate that fails validate() and began inside an escape is tried
   * again one character later (see applyRetrying).
   */
  retryInsideEscape?: boolean;
}

// IBANs, compact or in groups of four (#90). Before the card and phone
// patterns, which would otherwise take only the digit tail and leave the
// country code, check digits and bank code in place.
const IBAN: Rule = {
  pattern: /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?\b/g,
  replacement: IBAN_TOKEN,
  validate: passesIbanCheck,
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
  replacement: ADDRESS_TOKEN,
};
const ADDRESS_RULES: readonly Rule[] = [ADDRESS];

interface Engine {
  /** The id mask, or null: the pre-#182 patterns run over the whole text. */
  mask: RegExp | null;
  /** The patterns that run between masked ids, in order, per flavor. */
  rules: Record<PiiFlavor, readonly Rule[]>;
}

/** The #182 patterns. Throws where the engine has no lookbehind. */
function currentEngine(): Engine {
  const rx = (source: string) => new RegExp(source, "g");
  const iban: Rule = { ...IBAN, retryInsideEscape: true };
  // 13-19 digits with optional space or dash separators, Luhn checked.
  const card: Rule = {
    pattern: rx(`${START_CARD}(?:\\d[ -]*?){13,19}${END}`),
    replacement: CARD_TOKEN,
    validate: passesCardCheck,
    retryInsideEscape: true,
  };
  // Exactly 16 digits in a row, standing alone, whether or not they pass
  // Luhn: a card number with one mistyped digit always fails it, and so do
  // 16-digit gift card, loyalty and account numbers (review round 3). Grouped
  // `4-4-4-4` is not taken: "2022 2023 2024 2025" is a list of years.
  const card16: Rule = {
    pattern: rx(`${START}\\d{16}${END}`),
    replacement: CARD_TOKEN,
  };
  // SDK: dashed SSNs only, any area number (aligning with ingest: #193).
  const ssnSdk: Rule = {
    pattern: rx(`${START}\\d{3}-\\d{2}-\\d{4}${END}`),
    replacement: SSN_TOKEN,
  };
  // Ingest: dashed, spaced and bare SSNs, without the never-issued area
  // numbers 000, 666 and 900-999. Only the fully separated form
  // (`123-45-6789`, `123 45 6789`) uses START/END, so `ssn_123-45-6789` and
  // `SSN:123-45-6789` are redacted. Every other form, bare nine digits or one
  // separator (`123456789`, `123-456789`, `12345-6789`), keeps the `\b`
  // boundaries it had before #182 (decision A1, review round 2): on START/END,
  // ids like `order_123456789`, `KD123456789` or `ABC123-456789` would be cut,
  // so `ssn_123456789` stays unredacted as before.
  const ssnIngest: Rule = {
    pattern: rx(
      `${START}(?!000|666|9\\d{2})\\d{3}[- ]\\d{2}[- ]\\d{4}${END}|\\b(?!000|666|9\\d{2})\\d{3}[- ]?\\d{2}[- ]?\\d{4}\\b`,
    ),
    replacement: SSN_TOKEN,
  };
  // Ingest: US ITINs, 9XX-XX-XXXX, same token as an SSN, with the SSN's
  // boundaries per form.
  const itin: Rule = {
    pattern: rx(`${START}9\\d{2}[- ]\\d{2}[- ]\\d{4}${END}|\\b9\\d{2}[- ]?\\d{2}[- ]?\\d{4}\\b`),
    replacement: SSN_TOKEN,
  };
  // Phone numbers: an optional `+CC` or `00CC` and `(0)`, a first group of
  // 3-4 digits (so a trunk 0 or a leading 1 belongs to it: `0171 1234567`,
  // `(0171) 1234567`, `15551234567`) or of 5 digits starting with a trunk 0
  // (`07141 1234567`, review round 3), then 3 and 4 digits, each group
  // optionally separated by `-`, `.` or whitespace. Or a bare run of 12-15
  // digits that does not start with 1 (E.164 without the `+`: `491711234567`).
  const phone: Rule = {
    pattern: rx(
      `${START}(?:(?:\\+|00)\\d{1,3}[-.\\s]?(?:\\(0\\)[-.\\s]?)?)?\\(?(?:0\\d{4}|\\d{3,4})\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}${END}|${START}(?:0|[2-9])\\d{11,14}${END}`,
    ),
    replacement: PHONE_TOKEN,
  };
  return {
    mask: new RegExp(ID_MASK, "gi"),
    rules: {
      sdk: [iban, card, card16, ssnSdk, phone],
      ingest: [iban, card, card16, ssnIngest, itin, phone],
    },
  };
}

/**
 * The patterns of SDK 0.5.5 and the ingest before #182, verbatim, for an
 * engine without lookbehind (the React widget on Safari and iOS before
 * 16.4): no id mask, no boundary before a phone number. They cut ids
 * (`…-95[PHONE_REDACTED]`) and leave a trunk 0 in front of the token, but
 * never redact less than before, and the module never fails to load.
 */
function legacyEngine(): Engine {
  const card: Rule = {
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: CARD_TOKEN,
    validate: passesCardCheck,
  };
  const phone: Rule = {
    pattern: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: PHONE_TOKEN,
  };
  return {
    mask: null,
    rules: {
      sdk: [IBAN, card, { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: SSN_TOKEN }, phone],
      ingest: [
        IBAN,
        card,
        { pattern: /\b(?!000|666|9\d{2})\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, replacement: SSN_TOKEN },
        { pattern: /\b9\d{2}[- ]?\d{2}[- ]?\d{4}\b/g, replacement: SSN_TOKEN },
        phone,
      ],
    },
  };
}

let engine: Engine | undefined;

/** Compiled on first use: a SyntaxError here selects the pre-#182 patterns. */
function getEngine(): Engine {
  if (!engine) {
    try {
      engine = currentEngine();
    } catch {
      engine = legacyEngine();
    }
  }
  return engine;
}

/**
 * Every pattern but the email one needs a digit, so text without one is
 * returned as it is: the same output, without the scans.
 */
const DIGIT = /\d/;

/** A "%" or a "\u" with up to three hex digits right before a candidate. */
const INSIDE_ESCAPE = /(?:%|\\u[0-9A-Fa-f]{0,3})$/;

/**
 * A validated rule whose candidate began inside an escape and failed its
 * check: the scan resumes one character after that start instead of after
 * the candidate (#182 review round 2). `Pay%20with%204111111111111111`: the
 * card candidate `204111…` (the escape's own `20` in front) fails Luhn, and the
 * card right after the escape would otherwise never be tried.
 *
 * Forbidding a start inside an escape instead was measured and lost more than
 * it saved: the escape's digits are what lets `(890)%20567-5540` (an encoded
 * space between the groups) be caught as `%[SSN_REDACTED]`, and a "%" glued to
 * a number is as often a percent sign as an escape (`50%555-123-4567`).
 */
function applyRetrying(text: string, rule: Rule, hit: { redacted: boolean }): string {
  const { pattern, replacement, validate } = rule;
  let out = "";
  let last = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (validate?.(m[0]) !== false) {
      out += text.slice(last, m.index) + replacement;
      last = pattern.lastIndex;
      hit.redacted = true;
    } else if (INSIDE_ESCAPE.test(text.slice(Math.max(0, m.index - 5), m.index))) {
      pattern.lastIndex = m.index + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Each rule over the running result; a failed validation keeps the match. */
function applyRules(text: string, rules: readonly Rule[], hit: { redacted: boolean }): string {
  let result = text;
  for (const rule of rules) {
    if (rule.retryInsideEscape) {
      result = applyRetrying(result, rule, hit);
      continue;
    }
    const { pattern, replacement, validate } = rule;
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
function applyBetweenIds(
  text: string,
  { mask, rules }: { mask: RegExp | null; rules: readonly Rule[] },
  hit: { redacted: boolean },
): string {
  if (!mask) return applyRules(text, rules, hit);
  let out = "";
  let last = 0;
  // exec() on the engine's regex, not matchAll(), which copies it per call.
  // Synchronous and never re-entered, so its lastIndex is ours.
  mask.lastIndex = 0;
  for (let id = mask.exec(text); id !== null; id = mask.exec(text)) {
    out += applyToGap(text.slice(last, id.index), rules, hit) + id[0];
    last = mask.lastIndex;
  }
  // A masked id is never empty, so last === 0 means there was none.
  return last === 0 ? applyRules(text, rules, hit) : out + applyToGap(text.slice(last), rules, hit);
}

// Email addresses, as /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/g
// matched them (bounded to the RFC 5321 lengths), found from each "@"
// instead of from every position: the regex scanned up to 64 characters at
// every position of a long letter or digit run (~60 ms per 50 KB), this
// visits at most ~350 characters per "@". Same matches, same order.
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = (c: number) => isAlpha(c) || (c >= 48 && c <= 57);
/** [a-zA-Z0-9.-] */
const isDomainChar = (c: number) => isAlnum(c) || c === 46 || c === 45;
/** [a-zA-Z0-9._%+-] */
const isLocalChar = (c: number) => isDomainChar(c) || c === 95 || c === 37 || c === 43;

/**
 * Where the regex's domain and TLD end for a domain starting at `from`, or
 * -1. `[a-zA-Z0-9.-]{1,255}` is greedy and backtracks to the last `.` within
 * its 255 characters that is followed by two letters; the TLD then takes up
 * to 24 letters.
 */
function emailEnd(text: string, from: number): number {
  let dot = -1;
  for (let i = from; i - from <= 255 && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!isDomainChar(c)) break;
    if (
      c === 46 &&
      i > from &&
      isAlpha(text.charCodeAt(i + 1)) &&
      isAlpha(text.charCodeAt(i + 2))
    ) {
      dot = i;
    }
  }
  if (dot === -1) return -1;
  let end = dot + 1;
  while (end - dot <= 24 && isAlpha(text.charCodeAt(end))) end++;
  return end;
}

function replaceEmails(text: string, hit: { redacted: boolean }): string {
  let out = "";
  // The end of the previous match: the regex resumes there.
  let last = 0;
  let at = text.indexOf("@");
  while (at !== -1) {
    // "@" is not a local-part character, so a match ending its local part
    // here starts at the leftmost of the at most 64 local-part characters
    // right before it, not before the previous match.
    const floor = Math.max(last, at - 64);
    let start = at;
    while (start > floor && isLocalChar(text.charCodeAt(start - 1))) start--;
    const end = start < at ? emailEnd(text, at + 1) : -1;
    if (end === -1) {
      at = text.indexOf("@", at + 1);
      continue;
    }
    out += text.slice(last, start) + EMAIL_TOKEN;
    hit.redacted = true;
    last = end;
    at = text.indexOf("@", end);
  }
  return last === 0 ? text : out + text.slice(last);
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
  let result = replaceEmails(value, hit);
  if (!DIGIT.test(result)) return { result, redacted: hit.redacted };
  const { mask, rules } = getEngine();
  result = applyBetweenIds(result, { mask, rules: rules[flavor] }, hit);
  if (flavor === "ingest") result = applyRules(result, ADDRESS_RULES, hit);
  return { result, redacted: hit.redacted };
}
