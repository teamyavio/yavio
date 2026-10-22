import {
  analyticsFilterSearch,
  analyticsSection,
  parseLastView,
  serializeLastView,
} from "@/lib/navigation";
import { describe, expect, it } from "vitest";

// #43: navigation must keep the section and the analytics filters.
describe("analyticsFilterSearch", () => {
  it("keeps only the params the analytics filters own", () => {
    const params = new URLSearchParams(
      "from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z&platform=chatgpt,claude&page=3&tab=members",
    );
    expect(analyticsFilterSearch(params)).toBe(
      "?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-08T00%3A00%3A00.000Z&platform=chatgpt%2Cclaude",
    );
  });

  it("is empty when the URL carries no filters", () => {
    expect(analyticsFilterSearch(new URLSearchParams("page=2"))).toBe("");
    expect(analyticsFilterSearch(new URLSearchParams("from="))).toBe("");
  });
});

describe("analyticsSection", () => {
  it("names the section of a project page, including nested ones", () => {
    expect(analyticsSection("/ws/proj/overview", "/ws/proj")).toBe("overview");
    expect(analyticsSection("/ws/proj/tools", "/ws/proj")).toBe("tools");
    expect(analyticsSection("/ws/proj/tools/search%20items", "/ws/proj")).toBe("tools");
    expect(analyticsSection("/ws/proj/invocations", "/ws/proj")).toBe("invocations");
  });

  it("is null outside the analytics pages", () => {
    expect(analyticsSection("/ws/settings", "/ws/proj")).toBeNull();
    expect(analyticsSection("/settings/account", "/ws/proj")).toBeNull();
    expect(analyticsSection("/ws/proj/unknown", "/ws/proj")).toBeNull();
    expect(analyticsSection("/ws/proj", "/ws/proj")).toBeNull();
    expect(analyticsSection("/ws/proj/overview", "")).toBeNull();
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const filterSearch = (from: number, to: number, platform?: string) =>
  analyticsFilterSearch(
    new URLSearchParams({ from: iso(from), to: iso(to), ...(platform ? { platform } : {}) }),
  );

describe("last view round trip", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");

  it("serializes section plus a custom window and parses them back", () => {
    // 19 days is no preset, so the dates themselves are remembered.
    const from = now.getTime() - 20 * DAY_MS;
    const to = now.getTime() - DAY_MS;
    const view = { section: "tools" as const, search: filterSearch(from, to, "chatgpt") };
    expect(serializeLastView(view)).toBe(
      `tools?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}&platform=chatgpt`,
    );
    expect(parseLastView(serializeLastView(view), now)).toEqual(view);
    expect(parseLastView("live", now)).toEqual({ section: "live", search: "" });
  });

  it("rejects stale or hand-edited values instead of linking to them", () => {
    expect(parseLastView(null, now)).toBeNull();
    expect(parseLastView("", now)).toBeNull();
    expect(parseLastView("intents?range=7d", now)).toBeNull();
    expect(parseLastView("../settings", now)).toBeNull();
    // Unknown params and unparsable dates are stripped, the section survives.
    expect(parseLastView("errors?from=a&to=b&tab=members&page=9&platform=claude", now)).toEqual({
      section: "errors",
      search: "?platform=claude",
    });
    expect(parseLastView("errors?range=99d", now)).toEqual({ section: "errors", search: "" });
  });
});

// #146 review round 1, finding 1: a remembered window must not go stale.
describe("last view freshness", () => {
  const storedAt = new Date("2026-02-01T12:00:00.000Z");
  const readAt = new Date("2026-03-01T08:30:00.000Z");

  it("remembers a preset window as the preset and expands it to a fresh window on read", () => {
    const search = filterSearch(storedAt.getTime() - 7 * DAY_MS, storedAt.getTime(), "chatgpt");
    const stored = serializeLastView({ section: "overview", search });
    expect(stored).toBe("overview?range=7d&platform=chatgpt");

    expect(parseLastView(stored, readAt)).toEqual({
      section: "overview",
      search: filterSearch(readAt.getTime() - 7 * DAY_MS, readAt.getTime(), "chatgpt"),
    });
  });

  it("treats a window within an hour of a preset's length as that preset, like the picker", () => {
    // The sidebar re-reads and re-stores its own expansion: it must stay a preset.
    const to = storedAt.getTime();
    const search = filterSearch(to - 30 * DAY_MS + 20 * 60 * 1000, to);
    expect(serializeLastView({ section: "users", search })).toBe("users?range=30d");
    const expanded = parseLastView("users?range=30d", storedAt);
    expect(serializeLastView(expanded as NonNullable<typeof expanded>)).toBe("users?range=30d");
  });

  it("keeps a custom window while it is recent and drops it once it is a month old", () => {
    const from = storedAt.getTime() - 10 * DAY_MS;
    const to = storedAt.getTime() - 5 * DAY_MS;
    const stored = serializeLastView({
      section: "tools",
      search: filterSearch(from, to, "claude"),
    });

    const soon = new Date(to + 29 * DAY_MS);
    expect(parseLastView(stored, soon)).toEqual({
      section: "tools",
      search: filterSearch(from, to, "claude"),
    });

    const later = new Date(to + 31 * DAY_MS);
    expect(parseLastView(stored, later)).toEqual({ section: "tools", search: "?platform=claude" });
  });

  it("drops a window whose end precedes its start", () => {
    const stored = `errors?from=${encodeURIComponent(iso(storedAt.getTime()))}&to=${encodeURIComponent(iso(storedAt.getTime() - DAY_MS))}`;
    expect(parseLastView(stored, storedAt)).toEqual({ section: "errors", search: "" });
  });
});
