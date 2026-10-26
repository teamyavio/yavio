import { describe, expect, it } from "vitest";
import { stripPiiString } from "../pii.js";
import { ID_KINDS, prng } from "./pii-id-corpus.js";

/**
 * #182: the phone pattern had no leading boundary and cut the last ten
 * decimal digits of a hex run (1.8 % of UUIDs, 1.9 % of traceparents inside
 * text), and the card pattern took all-digit UUID segments. 200 000 values
 * for each UUID and traceparent kind (the acceptance criterion), 20 000 for
 * the rest; PII_ID_CORPUS_SIZE sets every kind to that size instead.
 * IBAN-shaped hex is a separate issue (#191), so only the phone, card and
 * SSN tokens count here.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const override = Number(env?.PII_ID_CORPUS_SIZE) || 0;
const MAIN = new Set([
  "UUID v4",
  "UUID v4, upper case",
  "traceparent inside text",
  "traceparent, upper case",
]);
const DIGIT_TOKENS = /\[(?:PHONE|CC|SSN)_REDACTED\]/;
const KINDS = Object.keys(ID_KINDS).map(
  (kind) => [kind, override || (MAIN.has(kind) ? 200_000 : 20_000)] as const,
);

describe("ids are not cut by the phone, card or SSN patterns (#182)", () => {
  it.each(KINDS)("%s (%i values, both flavors)", { timeout: 120_000 }, (kind, count) => {
    const generate = ID_KINDS[kind] as (r: () => number) => string;
    const r = prng(4242 + kind.length);
    let cut = 0;
    const examples: string[] = [];
    for (let i = 0; i < count; i++) {
      const value = generate(r);
      for (const flavor of ["sdk", "ingest"] as const) {
        const { result } = stripPiiString(value, flavor);
        if (result === value || !DIGIT_TOKENS.test(result)) continue;
        cut++;
        if (examples.length < 3) examples.push(`${flavor}: ${value} -> ${result}`);
      }
    }
    expect({ cut, examples }).toEqual({ cut: 0, examples: [] });
  });
});
