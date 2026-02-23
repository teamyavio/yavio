import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryDropOffTraces,
  queryFunnelProgression,
  queryTraceTimeline,
} from "@/lib/queries/funnels";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01T00:00:00.000Z",
  to: "2025-01-08T00:00:00.000Z",
};

describe("funnel queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryFunnelProgression", () => {
    it("calculates drop-off percentages from max count", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { stepSequence: 1, eventName: "start", traceCount: 100 },
        { stepSequence: 2, eventName: "search", traceCount: 80 },
        { stepSequence: 3, eventName: "purchase", traceCount: 20 },
      ]);

      const result = await queryFunnelProgression(baseCtx);
      expect(result).toHaveLength(3);
      expect(result[0].dropOffPercent).toBe(0);
      expect(result[1].dropOffPercent).toBeCloseTo(0.2);
      expect(result[2].dropOffPercent).toBeCloseTo(0.8);
    });

    it("returns empty array for no data", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      const result = await queryFunnelProgression(baseCtx);
      expect(result).toEqual([]);
    });
  });

  describe("queryDropOffTraces", () => {
    it("returns trace IDs that dropped off at a step", async () => {
      mockQueryAnalytics.mockResolvedValue([{ traceId: "tr_1" }, { traceId: "tr_2" }]);

      const result = await queryDropOffTraces(baseCtx, 2);
      expect(result).toEqual(["tr_1", "tr_2"]);

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.step).toBe(2);
    });
  });

  describe("queryTraceTimeline", () => {
    it("returns events for a trace", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { eventId: "e1", eventType: "step", timestamp: "2025-01-01" },
      ]);

      const result = await queryTraceTimeline(baseCtx, "tr_123");
      expect(result).toHaveLength(1);

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.traceId).toBe("tr_123");
    });
  });
});
