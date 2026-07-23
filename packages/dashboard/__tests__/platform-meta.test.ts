import {
  PLATFORM_META,
  orderedPlatforms,
  platformLabel,
} from "@/components/analytics/platform-meta";
import { platformValues } from "@yavio/shared/platform";
import { describe, expect, it } from "vitest";

describe("platform display metadata", () => {
  it("orderedPlatforms covers every platform exactly once", () => {
    // `satisfies readonly Platform[]` only checks element types, not
    // coverage — this guards against a new platform being filterable via
    // URL but invisible in the picker.
    expect([...orderedPlatforms].sort()).toEqual([...platformValues].sort());
  });

  it("every platform has a label and an icon", () => {
    for (const platform of platformValues) {
      expect(PLATFORM_META[platform].label).toBeTruthy();
      expect(PLATFORM_META[platform].icon).toBeTruthy();
    }
  });

  it("platformLabel falls back to the raw value for historical data", () => {
    expect(platformLabel("claude-desktop")).toBe("claude-desktop");
    expect(platformLabel("claude")).toBe("Claude");
  });
});
