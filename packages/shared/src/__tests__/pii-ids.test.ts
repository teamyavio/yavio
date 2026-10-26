import { describe, expect, it } from "vitest";
import { stripPiiString } from "../pii.js";
import { ID_KINDS, prng } from "./pii-id-corpus.js";

/**
 * #182: the phone pattern had no leading boundary and cut the last ten
 * decimal digits of a hex run (1.8 % of UUIDs, 1.9 % of traceparents inside
 * text), and the card pattern took all-digit UUID segments. 200 000 values
 * for each UUID and traceparent kind (the acceptance criterion), 20 000 for
 * the rest; PII_ID_CORPUS_SIZE (a positive integer) sets every kind to that
 * size instead. IBAN-shaped hex is a separate issue (#191), so only the
 * phone, card and SSN tokens count here.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const raw = env?.PII_ID_CORPUS_SIZE;
const override = raw === undefined || raw === "" ? 0 : Number(raw);
if (raw !== undefined && raw !== "" && !(Number.isInteger(override) && override > 0)) {
  // A size of 0, a negative one or a typo would make every kind pass vacuously.
  throw new Error(`PII_ID_CORPUS_SIZE must be a positive integer, got ${JSON.stringify(raw)}`);
}
const MAIN = new Set([
  "UUID v4",
  "UUID v4, upper case",
  "traceparent inside text",
  "traceparent, upper case",
]);
const DIGIT_TOKENS = /\[(?:PHONE|CC|SSN)_REDACTED\]/;
const PHONE = "555-123-4567";
const KINDS = Object.keys(ID_KINDS).map(
  (kind) => [kind, override || (MAIN.has(kind) ? 200_000 : 20_000)] as const,
);

describe("ids are not cut by the phone, card or SSN patterns (#182)", () => {
  it.each(KINDS)("%s (%i values, both flavors)", { timeout: 120_000 }, (kind, count) => {
    const generate = ID_KINDS[kind] as (r: () => number) => string;
    const r = prng(4242 + kind.length);
    const seen = new Set<string>();
    let cut = 0;
    let controls = 0;
    const examples: string[] = [];
    for (let i = 0; i < count; i++) {
      const value = generate(r);
      seen.add(value);
      for (const flavor of ["sdk", "ingest"] as const) {
        const { result } = stripPiiString(value, flavor);
        if (result !== value && DIGIT_TOKENS.test(result)) {
          cut++;
          if (examples.length < 3) examples.push(`${flavor}: ${value} -> ${result}`);
        }
        // Positive control: a phone number next to the id is still redacted,
        // so a stripper that does nothing cannot pass.
        if (i % 1_000 === 0) {
          // "call" keeps the id's trailing digits out of the number (a
          // version's `.721 555-…` would otherwise be a Luhn-valid card).
          const withPhone = stripPiiString(`${value} call ${PHONE}`, flavor).result;
          if (!withPhone.endsWith(" call [PHONE_REDACTED]")) {
            examples.push(`${flavor} control: ${value} call ${PHONE} -> ${withPhone}`);
          }
          controls++;
        }
      }
    }
    expect({ cut, examples }).toEqual({ cut: 0, examples: [] });
    // The corpus is what the title says: that many values, nearly all distinct.
    expect(controls).toBe(2 * Math.ceil(count / 1_000));
    expect(seen.size).toBeGreaterThan(0.99 * count);
  });
});
