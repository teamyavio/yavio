import type { ClickHouseClient } from "@clickhouse/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchWriter } from "../lib/batch-writer.js";
import type { EnrichedEvent } from "../lib/event-enricher.js";

function makeEvent(id = "evt-1"): EnrichedEvent {
  return {
    event_id: id,
    event_type: "track",
    trace_id: "trace-1",
    session_id: "session-1",
    timestamp: new Date().toISOString(),
    source: "server",
    workspace_id: "ws-1",
    project_id: "proj-1",
    ingested_at: new Date().toISOString(),
  };
}

function mockClickHouse(insertFn?: () => Promise<void>) {
  return {
    insert: insertFn ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as ClickHouseClient;
}

describe("BatchWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues events and returns false (no backpressure)", () => {
    const writer = new BatchWriter({ clickhouse: mockClickHouse() });
    const result = writer.enqueue([makeEvent()]);
    expect(result).toBe(false);
    expect(writer.bufferedCount).toBe(1);
  });

  it("returns true when buffer exceeds max size (backpressure)", () => {
    const writer = new BatchWriter({
      clickhouse: mockClickHouse(),
      maxBufferSize: 2,
    });
    writer.enqueue([makeEvent("1"), makeEvent("2")]);
    const result = writer.enqueue([makeEvent("3")]);
    expect(result).toBe(true);
  });

  it("flushes events to ClickHouse", async () => {
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const ch = mockClickHouse(insertFn);
    const writer = new BatchWriter({ clickhouse: ch, flushSize: 5 });

    writer.enqueue([makeEvent()]);
    await writer.flush();

    expect(insertFn).toHaveBeenCalledWith({
      table: "events",
      values: [expect.objectContaining({ event_id: "evt-1" })],
      format: "JSONEachRow",
    });
    expect(writer.bufferedCount).toBe(0);
  });

  it("does not flush when buffer is empty", async () => {
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const ch = mockClickHouse(insertFn);
    const writer = new BatchWriter({ clickhouse: ch });

    await writer.flush();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("auto-flushes when flushSize is reached", async () => {
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const ch = mockClickHouse(insertFn);
    const writer = new BatchWriter({ clickhouse: ch, flushSize: 2 });

    writer.enqueue([makeEvent("1"), makeEvent("2")]);

    // Allow the async flush to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(insertFn).toHaveBeenCalled();
  });

  it("timer triggers periodic flush", async () => {
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const ch = mockClickHouse(insertFn);
    const writer = new BatchWriter({
      clickhouse: ch,
      flushIntervalMs: 1_000,
      flushSize: 100,
    });

    writer.start();
    writer.enqueue([makeEvent()]);

    await vi.advanceTimersByTimeAsync(1_001);

    expect(insertFn).toHaveBeenCalled();
    await writer.shutdown();
  });

  it("retries failed inserts with exponential backoff", async () => {
    let attempt = 0;
    const insertFn = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt < 3) throw new Error("ClickHouse unavailable");
    });
    const ch = mockClickHouse(insertFn);
    const writer = new BatchWriter({ clickhouse: ch, flushSize: 100 });

    writer.enqueue([makeEvent()]);

    // Manually trigger flush
    const flushPromise = writer.flush();

    // Advance past retry delays (1s, 2s)
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await flushPromise;

    expect(insertFn).toHaveBeenCalledTimes(3);
    expect(writer.bufferedCount).toBe(0);
  });

  it("re-buffers events on complete failure", async () => {
    const insertFn = vi.fn().mockRejectedValue(new Error("always fails"));
    const ch = mockClickHouse(insertFn);
    const writer = new BatchWriter({ clickhouse: ch, flushSize: 100 });

    writer.enqueue([makeEvent()]);

    const flushPromise = writer.flush();

    // Advance past all retry delays
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await flushPromise;

    // Events should be re-buffered
    expect(writer.bufferedCount).toBe(1);
  });

  it("shutdown drains all events", async () => {
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const ch = mockClickHouse(insertFn);
    const writer = new BatchWriter({
      clickhouse: ch,
      flushIntervalMs: 60_000,
      flushSize: 100,
    });

    writer.start();
    writer.enqueue([makeEvent("1"), makeEvent("2")]);

    await writer.shutdown();

    expect(insertFn).toHaveBeenCalled();
    expect(writer.bufferedCount).toBe(0);
  });

  it("start is idempotent", () => {
    const writer = new BatchWriter({ clickhouse: mockClickHouse() });
    writer.start();
    writer.start(); // should not throw or create duplicate timers
    writer.shutdown();
  });
});
