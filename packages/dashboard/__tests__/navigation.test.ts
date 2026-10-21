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

describe("last view round trip", () => {
  it("serializes section plus filters and parses them back", () => {
    const view = { section: "tools" as const, search: "?from=a&to=b&platform=chatgpt" };
    expect(serializeLastView(view)).toBe("tools?from=a&to=b&platform=chatgpt");
    expect(parseLastView(serializeLastView(view))).toEqual(view);
    expect(parseLastView("live")).toEqual({ section: "live", search: "" });
  });

  it("rejects stale or hand-edited values instead of linking to them", () => {
    expect(parseLastView(null)).toBeNull();
    expect(parseLastView("")).toBeNull();
    expect(parseLastView("intents?from=a")).toBeNull();
    expect(parseLastView("../settings")).toBeNull();
    // Unknown params are stripped, the section survives.
    expect(parseLastView("errors?from=a&tab=members&page=9")).toEqual({
      section: "errors",
      search: "?from=a",
    });
  });
});
