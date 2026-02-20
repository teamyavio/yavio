import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../../transport/http.js";

describe("Shutdown flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes all remaining events on shutdown", async () => {
    const batches: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      batches.push(...(body.events as BaseEvent[]).map((e: BaseEvent) => e.event_id));
      return { status: 200, headers: { get: () => null }, json: () => ({}) };
    });

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBatchSize: 3,
      flushIntervalMs: 60_000, // Very long — won't auto-flush
      fetch: mockFetch,
    });
    transport.start();

    // Enqueue 7 events
    const eventIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = crypto.randomUUID();
      eventIds.push(id);
      transport.send([
        {
          event_id: id,
          event_type: "track",
          trace_id: "tr_test",
          session_id: "ses_test",
          timestamp: new Date().toISOString(),
          source: "server",
        } as BaseEvent,
      ]);
    }

    // Shutdown should flush all remaining events
    await transport.shutdown();

    // All 7 events should be delivered in 3 batches (3+3+1)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(batches).toHaveLength(7);
    // All event IDs should be present
    for (const id of eventIds) {
      expect(batches).toContain(id);
    }
  });

  it("stops accepting new events after shutdown", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: () => ({}),
    });

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetch: mockFetch,
    });

    await transport.shutdown();

    // Send after shutdown
    transport.send([
      {
        event_id: crypto.randomUUID(),
        event_type: "track",
        trace_id: "tr_test",
        session_id: "ses_test",
        timestamp: new Date().toISOString(),
        source: "server",
      } as BaseEvent,
    ]);

    await transport.flush();

    // Should not have sent anything (no events before shutdown, send after ignored)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
