import type { BaseEvent } from "@yavio/shared/events";
import { describe, expect, it } from "vitest";
import { MAX_FUTURE_MS, MAX_PAST_MS, normalizeEvents } from "../lib/event-normalizer.js";
import { COUNTRY_CODES, CURRENCY_CODES } from "../lib/iso-codes.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function event(overrides: Record<string, unknown> = {}): BaseEvent {
  return {
    event_id: "4b6f3a52-1c3e-4c5e-9a3d-8e2f1b7c6d5a",
    event_type: "tool_call",
    trace_id: "trace-1",
    session_id: "session-1",
    timestamp: new Date(NOW).toISOString(),
    source: "server",
    ...overrides,
  } as BaseEvent;
}

describe("timestamp clamping (#90)", () => {
  it("clamps an event dated a year ahead to now + 5 min, and counts it", () => {
    const r = normalizeEvents([event({ timestamp: "2027-10-14T12:00:00.000Z" })], NOW);
    expect(r.events[0].timestamp).toBe(new Date(NOW + MAX_FUTURE_MS).toISOString());
    expect(r.clampedTimestamps).toBe(1);
  });

  it("clamps an event a year old to now - 72 h", () => {
    const r = normalizeEvents([event({ timestamp: "2025-10-14T12:00:00.000Z" })], NOW);
    expect(r.events[0].timestamp).toBe(new Date(NOW - MAX_PAST_MS).toISOString());
    expect(r.clampedTimestamps).toBe(1);
  });

  it("leaves timestamps inside the window untouched", () => {
    const inside = [
      new Date(NOW - MAX_PAST_MS).toISOString(),
      new Date(NOW - 60_000).toISOString(),
      new Date(NOW + MAX_FUTURE_MS).toISOString(),
    ];
    const r = normalizeEvents(
      inside.map((timestamp) => event({ timestamp })),
      NOW,
    );
    expect(r.events.map((e) => e.timestamp)).toEqual(inside);
    expect(r.clampedTimestamps).toBe(0);
  });
});

describe("format checks (#90) — invalid becomes NULL, the event is kept", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["country_code", "DE", "DE"],
    ["country_code", "de", "DE"],
    ["country_code", "XK", "XK"],
    ["country_code", "EU", null],
    ["country_code", "ZZ", null],
    ["country_code", "UK", null],
    ["country_code", "Q1", null],
    ["conversion_currency", "EUR", "EUR"],
    ["conversion_currency", "usd", "USD"],
    ["conversion_currency", "VED", "VED"],
    ["conversion_currency", "ABC", null],
    ["conversion_currency", "XAU", null],
    ["locale", "de-DE", "de-DE"],
    ["locale", "en-us", "en-US"],
    ["locale", "zh-Hant-TW", "zh-Hant-TW"],
    ["locale", "en_US", "en-US"], // the POSIX spelling is normalised (#111)
    ["locale", "de_DE", "de-DE"],
    ["locale", "zh_Hant_TW", "zh-Hant-TW"],
    ["locale", "en_US.UTF-8", "en-US"], // as read from LANG / LC_ALL
    ["locale", "de_DE@euro", "de-DE"],
    ["locale", "C", null], // no language in the C and POSIX locales
    ["locale", "POSIX", null],
    ["locale", "C.UTF-8", null],
    ["locale", "not a locale", null],
  ];

  it.each(cases)("%s %j -> %j", (field, input, expected) => {
    const r = normalizeEvents([event({ [field]: input })], NOW);
    expect(r.events).toHaveLength(1);
    expect((r.events[0] as Record<string, unknown>)[field]).toEqual(expected);
    expect(r.invalidFields).toBe(expected === null ? 1 : 0);
  });

  it("leaves absent fields absent", () => {
    const r = normalizeEvents([event()], NOW);
    expect(r.events[0]).not.toHaveProperty("country_code");
    expect(r.invalidFields).toBe(0);
  });
});

describe("code lists", () => {
  it("has the 249 ISO 3166-1 alpha-2 codes plus XK", () => {
    expect(COUNTRY_CODES.size).toBe(250);
    for (const code of ["DE", "US", "GB", "SS", "XK"]) expect(COUNTRY_CODES.has(code)).toBe(true);
  });

  it("has the common ISO 4217 currencies", () => {
    for (const code of ["EUR", "USD", "GBP", "CHF", "JPY", "VED"]) {
      expect(CURRENCY_CODES.has(code)).toBe(true);
    }
  });
});
