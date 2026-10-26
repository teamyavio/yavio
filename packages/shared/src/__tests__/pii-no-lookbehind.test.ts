import { describe, expect, it, vi } from "vitest";
import { ID_KINDS, prng } from "./pii-id-corpus.js";
import { ingestPre182, sdkPre182 } from "./pii-pre182.js";

/**
 * #182 review round 1: the React widget bundles @yavio/shared/pii, and
 * Safari and iOS before 16.4 have no regex lookbehind. There a lookbehind
 * literal makes the whole bundle fail to parse, and `new RegExp` with one
 * throws. The module writes none as a literal (check:package scans dist/ for
 * that) and compiles them on first use; when that throws, it falls back to
 * the pre-#182 patterns. Here RegExp throws on every lookbehind, as such an
 * engine does, while a fresh copy of the module loads and runs.
 */
const LOOKBEHIND = /\(\?<[=!]/;

const INPUTS = [
  "contact user@example.com",
  "a@b.com and c@d.org",
  "call 0171-1234567",
  "Tel. 0171 1234567",
  "(0171) 1234567",
  "+49 (0)171 1234567",
  "0049 171 1234567",
  "491711234567",
  "+1 (555) 123-4567",
  "call 5551234567.",
  "15551234567",
  "1-800-555-1234",
  "Tel5551234567",
  "phone_5551234567",
  "cafe555-123-4567",
  "cafe5551234567",
  "?phone=%2B4917612345678",
  "?msg=Call%20me%20at%20555-123-4567",
  '{"t":"Tel.\\u00a00171 1234567"}',
  "Pay%20with%204111111111111111",
  "Call%20me%20at%20Tel5551234567",
  '{"t":"Jane\\f5551234567"}',
  "ABC123-456789",
  "SSN: 123-456789",
  "Card: 4111 1111 1111 1111",
  "card_4111111111111111",
  "4111 1111 1111 1111 12/27",
  "ID: 1234567890123",
  "SSN: 123-45-6789",
  "ssn_123-45-6789",
  "SSN: 123 45 6789",
  "SSN: 123456789",
  "order_123456789",
  "ITIN: 912-34-5678",
  "000-12-3456",
  "IBAN DE89 3704 0044 0532 0130 00.",
  "Ship to 100 Pine Ave Apt 4B",
  "47e16ee3-3d22-430b-acb1-959114949231",
  "21165216-7349-4227-981e-df7d3bf851dc",
  "%2F47e16ee3-3d22-430b-acb1-959114949231",
  "b7ad6b7169203331",
  "deadbeef5551234567",
  "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01",
  "traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01, call 555-123-4567",
  '{"createdAt":1761484800127}',
  "ORD-2026-1234567890",
  "Comparing revenue for 2022 2023 2024 2025",
  "",
];

describe("an engine without regex lookbehind (#182 review round 1)", () => {
  it("loads the module, and strips exactly like the pre-#182 strippers", async () => {
    const r = prng(194);
    const values = [...INPUTS];
    for (const generate of Object.values(ID_KINDS)) {
      for (let i = 0; i < 300; i++) values.push(generate(r));
    }

    const Real = globalThis.RegExp;
    let refused = 0;
    const check = (args: unknown[]) => {
      const [pattern] = args;
      const source = pattern instanceof Real ? pattern.source : String(pattern);
      if (LOOKBEHIND.test(source)) {
        refused++;
        throw new SyntaxError(`Invalid regular expression: /${source}/: Invalid group`);
      }
    };
    const NoLookbehind = new Proxy(Real, {
      construct(target, args) {
        check(args);
        return Reflect.construct(target, args);
      },
      apply(target, thisArg, args) {
        check(args);
        return Reflect.apply(target, thisArg, args);
      },
    });

    vi.resetModules();
    globalThis.RegExp = NoLookbehind;
    let outputs: Array<{
      value: string;
      sdk: { result: string; redacted: boolean };
      ingest: { result: string; redacted: boolean };
    }>;
    try {
      const pii = await import("../pii.js");
      outputs = values.map((value) => ({
        value,
        sdk: pii.stripPiiString(value, "sdk"),
        ingest: pii.stripPiiString(value, "ingest"),
      }));
    } finally {
      globalThis.RegExp = Real;
    }

    // The lookbehind patterns were tried, refused, and not used.
    expect(refused).toBeGreaterThan(0);
    const differ = outputs.filter(({ value, sdk, ingest }) => {
      const old = ingestPre182(value);
      return (
        sdk.result !== sdkPre182(value) ||
        sdk.redacted !== (sdk.result !== value) ||
        ingest.result !== old.result ||
        ingest.redacted !== old.redacted
      );
    });
    expect(differ).toEqual([]);
    // The pre-#182 behaviour, ids cut included.
    expect(outputs[INPUTS.indexOf("47e16ee3-3d22-430b-acb1-959114949231")]?.sdk.result).toBe(
      "47e16ee3-3d22-430b-acb1-95[PHONE_REDACTED]",
    );
  });
});
