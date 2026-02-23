import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import { queryPathSequences } from "@/lib/queries/paths";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01T00:00:00.000Z",
  to: "2025-01-08T00:00:00.000Z",
};

describe("path queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryPathSequences", () => {
    it("returns links and unique nodes", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { source: "search", target: "summarize", value: 50 },
        { source: "summarize", target: "translate", value: 30 },
      ]);

      const result = await queryPathSequences(baseCtx);
      expect(result.links).toHaveLength(2);
      expect(result.links[0].value).toBe(50);
      expect(result.nodes).toContain("search");
      expect(result.nodes).toContain("summarize");
      expect(result.nodes).toContain("translate");
      expect(result.nodes).toHaveLength(3);
    });

    it("applies start tool filter", async () => {
      mockQueryAnalytics.mockResolvedValue([]);

      await queryPathSequences(baseCtx, "search");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("source = {startTool:String}");
      expect(call.params.startTool).toBe("search");
    });

    it("applies end tool filter", async () => {
      mockQueryAnalytics.mockResolvedValue([]);

      await queryPathSequences(baseCtx, undefined, "translate");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("target = {endTool:String}");
      expect(call.params.endTool).toBe("translate");
    });

    it("returns empty results", async () => {
      mockQueryAnalytics.mockResolvedValue([]);

      const result = await queryPathSequences(baseCtx);
      expect(result.links).toEqual([]);
      expect(result.nodes).toEqual([]);
    });
  });
});
