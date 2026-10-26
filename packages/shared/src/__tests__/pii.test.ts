import { describe, expect, it } from "vitest";
import { isTraceparent, stripPiiString } from "../pii.js";
import { ID_KINDS, prng } from "./pii-id-corpus.js";

const P = "[PHONE_REDACTED]";
const CC = "[CC_REDACTED]";
const SSN = "[SSN_REDACTED]";
const W3C = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

/**
 * [input, SDK output, ingest output (when it differs from the SDK's)]. Every
 * row is the exact output, so a pattern that starts to cut more, or less,
 * shows up here.
 */
type Row = [input: string, sdk: string, ingest?: string];

const PHONES: Row[] = [
  // A trunk 0, `00` and `(0)` belong to the number (#182): before, the
  // leading digits were left in front of the token (`call 0[PHONE_REDACTED]`).
  ["call 0171-1234567", `call ${P}`],
  ["Tel. 0171 1234567", `Tel. ${P}`],
  ["(0171) 1234567", P],
  ["01711234567", P],
  ["+49 171 1234567", P],
  ["+49 (0)171 1234567", P],
  ["0049 171 1234567", P],
  ["tel:+491711234567", `tel:${P}`],
  // A bare 12-15-digit run that does not start with 1: E.164 without the `+`.
  ["491711234567", P],
  ["+1 (555) 123-4567", P],
  ["(555) 123-4567", P],
  ["555.123.4567", P],
  ["call 5551234567.", `call ${P}.`],
  ["15551234567", P],
  // Glued to a word of letters with a non-hex letter, or to `_`: still a number.
  ["Tel5551234567", `Tel${P}`],
  ["phone_5551234567", `phone_${P}`],
  ['{"note":"Jane\\n5551234567"}', `{"note":"Jane\\n${P}"}`],
  // Glued to a word of letters a-f only, with a phone's shape: a `+`, a `(`
  // or a separator after the first group (#182 review round 1).
  ["cafe555-123-4567", `cafe${P}`],
  ["Ad+49 171 1234567", `Ad${P}`],
  ["ab(555) 123-4567", `ab${P}`],
];

const CARDS: Row[] = [
  ["Card: 4111 1111 1111 1111", `Card: ${CC}`],
  ["4111-1111-1111-1111", CC],
  ["card_4111111111111111", `card_${CC}`],
  ["card4111111111111111", `card${CC}`],
  ["4111 1111 1111 1111 12/27", `${CC} 12/27`],
  ["ab4111 1111 1111 1111", `ab${CC}`],
  // Luhn-invalid, 13 digits starting with 1: neither a card nor a phone.
  ["ID: 1234567890123", "ID: 1234567890123"],
];

const SSNS: Row[] = [
  ["SSN: 123-45-6789", `SSN: ${SSN}`],
  ["ssn_123-45-6789", `ssn_${SSN}`],
  // The SDK matches dashed SSNs only (#193); ingest spaced and bare ones too.
  ["SSN: 123 45 6789", "SSN: 123 45 6789", `SSN: ${SSN}`],
  ["SSN: 123456789", "SSN: 123456789", `SSN: ${SSN}`],
  // The bare nine digits keep their `\b` boundaries in ingest (#182, A1):
  // ids glued to a word are not cut, and `ssn_123456789` stays unredacted, as before.
  ["order_123456789", "order_123456789"],
  ["KD123456789", "KD123456789"],
  ["ssn_123456789", "ssn_123456789"],
  ["order_912345678", "order_912345678"],
  // ITINs: the SDK's dashed SSN pattern has no area exclusion, ingest has ITIN.
  ["ITIN: 912-34-5678", `ITIN: ${SSN}`],
  ["ITIN: 912345678", "ITIN: 912345678", `ITIN: ${SSN}`],
  ["000-12-3456", SSN, "000-12-3456"],
];

const IDS: Row[] = [
  // The phone pattern took the last ten decimal digits of a hex run.
  ["47e16ee3-3d22-430b-acb1-959114949231", "47e16ee3-3d22-430b-acb1-959114949231"],
  // The card pattern took the all-digit segments of a UUID.
  ["21165216-7349-4227-981e-df7d3bf851dc", "21165216-7349-4227-981e-df7d3bf851dc"],
  ["b7ad6b7169203331", "b7ad6b7169203331"],
  ["deadbeef5551234567", "deadbeef5551234567"],
  [W3C, W3C],
  [W3C.toUpperCase(), W3C.toUpperCase()],
  [`ff${W3C.slice(2)}`, `ff${W3C.slice(2)}`],
  [`traceparent: ${W3C}, call 555-123-4567`, `traceparent: ${W3C}, call ${P}`],
  [
    "47e16ee3-3d22-430b-acb1-959114949231 555-123-4567",
    `47e16ee3-3d22-430b-acb1-959114949231 ${P}`,
  ],
  // An epoch in ms starts with 1 and is Luhn-invalid here: kept.
  ['{"createdAt":1761484800127}', '{"createdAt":1761484800127}'],
];

/**
 * After a URL percent-escape or a JSON `\uXXXX` escape, which ends in a hex
 * digit glued to the number (#182 review round 1).
 */
const ESCAPES: Row[] = [
  ["?phone=%2B4917612345678", `?phone=%2B${P}`],
  ["?msg=Call%20me%20at%20555-123-4567", `?msg=Call%20me%20at%20${P}`],
  ["?msg=Call%20me%20at%200171-1234567", `?msg=Call%20me%20at%20${P}`],
  ["href=tel%3A235-515-6734", `href=tel%3A${P}`],
  ["Jane%0A5551234567", `Jane%0A${P}`],
  ['{"t":"Tel.\\u00a00171 1234567"}', `{"t":"Tel.\\u00a0${P}"}`],
  ['{"t":"Tel.\\u00a0+49 171 1234567"}', `{"t":"Tel.\\u00a0${P}"}`],
  ["ssn%3A123-45-6789", `ssn%3A${SSN}`],
  // An id right after an escape is masked like one standing alone.
  ["%2F47e16ee3-3d22-430b-acb1-959114949231", "%2F47e16ee3-3d22-430b-acb1-959114949231"],
  ["\\u002221165216-7349-4227-981e-df7d3bf851dc", "\\u002221165216-7349-4227-981e-df7d3bf851dc"],
];

const OTHER: Row[] = [
  ["contact user@example.com", "contact [EMAIL_REDACTED]"],
  // Email runs first, over the whole string: a UUID-shaped local part is an email.
  ["47e16ee3-3d22-430b-acb1-959114949231@example.com", "[EMAIL_REDACTED]"],
  ["IBAN DE89 3704 0044 0532 0130 00.", "IBAN [IBAN_REDACTED]."],
  ["send to DE89370400440532013000 by friday", "send to [IBAN_REDACTED] by friday"],
  ["Ship to 100 Pine Ave Apt 4B", "Ship to 100 Pine Ave Apt 4B", "Ship to [ADDRESS_REDACTED]"],
  ["Comparing revenue for 2022 2023 2024 2025", "Comparing revenue for 2022 2023 2024 2025"],
];

/** Documented ambiguities and misses: pinned so a change is a decision. */
const DOCUMENTED: Row[] = [
  // A standalone ten-digit number is a phone number, an id or an epoch
  // second alike (#192).
  ["ORD-2026-1234567890", `ORD-2026-${P}`],
  ['{"created":1761484800}', `{"created":${P}}`],
  // The NANP `1-` before a dashed ten-digit number stays.
  ["1-800-555-1234", `1-${P}`],
  // A 12-15-digit number that does not start with 1 is a phone number (EAN-13).
  ["EAN 4006381333931", `EAN ${P}`],
  // Letters on the right end no number, nor does a word of letters a-f only
  // on the left: the price of not cutting hex ids.
  ["5551234567x12", "5551234567x12"],
  ["abc5551234567", "abc5551234567"],
  ["cafe5551234567", "cafe5551234567"],
  // A double-encoded escape (`%25` + `2B`) is not one.
  ["%252B4917612345678", "%252B4917612345678"],
  // A UUID glued to a letter is not masked.
  ["x21165216-7349-4227-981e-df7d3bf851dc", `x${CC}-981e-df7d3bf851dc`],
  // A Luhn-invalid 16-digit number is no longer partly cut as a phone number.
  ["4111111111111112", "4111111111111112"],
  // Groupings other than 3/4 + 3 + 4 are not matched (#189).
  ["Tel: 030 12345678", "Tel: 030 12345678"],
  ["0171 123 45 67", "0171 123 45 67"],
  ["+44 20 7946 0958", "+44 20 7946 0958"],
];

const TABLE: Array<[string, Row[]]> = [
  ["phone", PHONES],
  ["card", CARDS],
  ["SSN and ITIN", SSNS],
  ["id", IDS],
  ["escape", ESCAPES],
  ["email, IBAN, address, prose", OTHER],
  ["documented ambiguity", DOCUMENTED],
];

describe.each(["sdk", "ingest"] as const)("stripPiiString(value, %j) (#182)", (flavor) => {
  for (const [group, rows] of TABLE) {
    it.each(rows)(`${group}: %j`, (input, sdk, ingest = sdk) => {
      const expected = flavor === "sdk" ? sdk : ingest;
      expect(stripPiiString(input, flavor)).toEqual({
        result: expected,
        redacted: expected !== input,
      });
    });
  }
});

describe("the SDK and ingest flavors mirror each other (#182)", () => {
  it("give the same output wherever only shared patterns apply", { timeout: 60_000 }, () => {
    // Ids of every kind, and every table row whose expectation is the same
    // for both flavors.
    const r = prng(99);
    const values: string[] = [];
    for (const generate of Object.values(ID_KINDS)) {
      for (let i = 0; i < 3_000; i++) values.push(generate(r));
    }
    for (const [, rows] of TABLE) {
      for (const [input, , ingest] of rows) if (ingest === undefined) values.push(input);
    }
    const differ = values.filter(
      (value) => stripPiiString(value, "sdk").result !== stripPiiString(value, "ingest").result,
    );
    expect(values.length).toBeGreaterThan(42_000);
    expect(differ).toEqual([]);
  });
});

describe("email addresses (#182 review round 1)", () => {
  // Matched from each "@" instead of by the regex, which scanned up to 64
  // characters at every position: the same matches, in linear time. Strings
  // without a digit, so that only the email rule applies.
  const OLD = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/g;
  const old = (value: string) => value.replace(OLD, "[EMAIL_REDACTED]");

  it.each([
    "user@example.com",
    "a@b@c.com",
    "a@b.cc.d@e.com",
    "x.y+tag%_z-@sub.example.co.uk, and again: q@w.io",
    `${"l".repeat(64)}@example.com`,
    `${"l".repeat(65)}@example.com`,
    `a@${"d".repeat(251)}.com`,
    `a@${"d".repeat(252)}.com`,
    `a@b.${"t".repeat(30)}`,
    "a@b.c",
    "a@.co",
    "@example.com",
    "a@b..co",
    "name@domain-with-dash.example",
  ])("%s", (value) => {
    const expected = old(value);
    for (const flavor of ["sdk", "ingest"] as const) {
      expect(stripPiiString(value, flavor)).toEqual({
        result: expected,
        redacted: expected !== value,
      });
    }
  });

  it("matches like the regex on 20 000 seeded strings", { timeout: 60_000 }, () => {
    const r = prng(5150);
    const ATOMS = ["@", "@", ".", "%", "+", "-", "_", " ", "a", "Z", ".co", "..", "x@y", "a@b.io"];
    const RUNS = ["a", ".", "%", "-", "b.c"];
    const differ: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      let value = "";
      const k = 1 + Math.floor(r() * 10);
      for (let j = 0; j < k; j++) {
        value +=
          r() < 0.15
            ? (RUNS[Math.floor(r() * RUNS.length)] as string).repeat(55 + Math.floor(r() * 210))
            : ATOMS[Math.floor(r() * ATOMS.length)];
      }
      const expected = old(value);
      const got = stripPiiString(value, "sdk");
      if (got.result !== expected || got.redacted !== (expected !== value)) differ.push(value);
    }
    expect(differ).toEqual([]);
  });
});

describe("isTraceparent", () => {
  it("accepts exactly a valid W3C traceparent", () => {
    expect(isTraceparent(W3C)).toBe(true);
    expect(isTraceparent(W3C.replace(/-01$/, "-00"))).toBe(true);
  });

  it.each([
    ["upper-case hex", W3C.toUpperCase()],
    ["version ff", `ff${W3C.slice(2)}`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-b7ad6b7169203331-01`],
    ["an all-zero parent id", `00-0af7651916cd43dd8448eb211c80319c-${"0".repeat(16)}-01`],
    ["a higher version's extra field", `01${W3C.slice(2)}-00`],
    ["a trailing newline", `${W3C}\n`],
    ["text around one", `traceparent: ${W3C}`],
  ])("rejects %s", (_case, value) => {
    expect(isTraceparent(value)).toBe(false);
  });

  it("is why stripPiiString returns a valid one unchanged and not redacted", () => {
    for (const flavor of ["sdk", "ingest"] as const) {
      expect(stripPiiString(W3C, flavor)).toEqual({ result: W3C, redacted: false });
    }
  });
});

describe("pathological input (#182)", () => {
  // Every pattern is linear on these; before #182 a 100 KB string took
  // 150-300 ms on a loaded machine, mostly in the email scan. The bound only
  // catches catastrophic backtracking, not a slow runner.
  const N = 100_000;
  const repeat = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const r = prng(5);
  let hex = "";
  for (let i = 0; i < N; i++) hex += "0123456789abcdef"[Math.floor(r() * 16)];

  it.each([
    ["digits", "1".repeat(N)],
    ["random hex", hex],
    ["a digit and 1000 spaces, repeated", repeat(`1${" ".repeat(1000)}`)],
    ["Tel and nine digits, repeated", repeat("Tel123456789")],
    ["letters a-z, repeated", repeat("abcdefghijklmnopqrstuvwxyz")],
    ["UUID-shaped values glued by dashes", repeat("00000000-0000-4000-8000-000000000000-")],
    // The email regex took ~450 ms on the next one (4.4 s at 1 MB): it
    // scanned up to 64 characters at every position.
    ["letters and one @ at the end", `${"a".repeat(N - 1)}@`],
    [
      "64 letters, @, 255 letters, a digit, repeated",
      repeat(`${"a".repeat(64)}@${"a".repeat(255)}1`),
    ],
    ["%2B and 13 digits, repeated", repeat("%2B4917612345678")],
  ])("%s (100 KB) in under 1 s per flavor", (_case, value) => {
    for (const flavor of ["sdk", "ingest"] as const) {
      const start = performance.now();
      stripPiiString(value, flavor);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });

  it("letters and one @ at the end, 1 MB, in under 1 s per flavor", () => {
    const value = `${"a".repeat(1_000_000 - 1)}@`;
    for (const flavor of ["sdk", "ingest"] as const) {
      const start = performance.now();
      stripPiiString(value, flavor);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});
