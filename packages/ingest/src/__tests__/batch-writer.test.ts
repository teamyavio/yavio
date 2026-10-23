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
      // async_insert is on by default from ClickHouse 26.3; this writer batches
      // itself and must stay on the regular insert path (#95, #90). The token
      // lets ClickHouse drop a retried batch it already stored (#90).
      clickhouse_settings: {
        async_insert: 0,
        insert_deduplication_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
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

  it("awaits an in-flight flush instead of skipping it", async () => {
    // Regression: flush() used to return immediately when another flush
    // was already running, so `await writer.flush()` gave no guarantee
    // that a just-enqueued event had been written (e.g. when the timer
    // flush grabbed it a moment earlier and its insert was still in
    // flight). Callers must observe completed writes after awaiting.
    vi.useRealTimers();
    let resolveInsert: () => void = () => {};
    const insertFn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInsert = resolve;
        }),
    );
    const writer = new BatchWriter({ clickhouse: mockClickHouse(insertFn) });

    writer.enqueue([makeEvent("evt-slow")]);
    const first = writer.flush(); // starts the slow insert

    let secondDone = false;
    const second = writer.flush().then(() => {
      secondDone = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(secondDone).toBe(false); // must wait for the in-flight insert

    resolveInsert();
    await first;
    await second;
    expect(secondDone).toBe(true);
    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  it("start is idempotent", () => {
    const writer = new BatchWriter({ clickhouse: mockClickHouse() });
    writer.start();
    writer.start(); // should not throw or create duplicate timers
    writer.shutdown();
  });

  it("sends the same deduplication token on every retry of a batch (#90)", async () => {
    vi.useFakeTimers();
    try {
      const insertFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValueOnce(undefined);
      const writer = new BatchWriter({ clickhouse: mockClickHouse(insertFn), flushSize: 5 });
      writer.enqueue([makeEvent()]);
      const flushing = writer.flush();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushing;

      expect(insertFn).toHaveBeenCalledTimes(2);
      const tokens = insertFn.mock.calls.map(
        (c) =>
          (c[0] as { clickhouse_settings: Record<string, unknown> }).clickhouse_settings
            .insert_deduplication_token,
      );
      expect(tokens[0]).toBe(tokens[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the same rows enriched again (an SDK resend making up a block of its own) the same token, and a clamped resend a new one", async () => {
    // The token is hashed from event_id and timestamp (#114; ingested_at
    // left the rows in #148 review round 5): a block of the same rows is
    // dropped by the deduplication window — the end state FINAL would
    // reach one merge later — while a resend whose timestamp the
    // normalizer clamped anew is told apart (#90).
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const writer = new BatchWriter({ clickhouse: mockClickHouse(insertFn), flushSize: 5 });
    const first = makeEvent("evt-same");
    writer.enqueue([first]);
    await writer.flush();
    writer.enqueue([{ ...first }]);
    await writer.flush();
    writer.enqueue([{ ...first, timestamp: new Date(Date.now() + 1_000).toISOString() }]);
    await writer.flush();
    const [a, b, c] = insertFn.mock.calls.map(
      (call) =>
        (call[0] as { clickhouse_settings: Record<string, unknown> }).clickhouse_settings
          .insert_deduplication_token,
    );
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("gives different batches different tokens", async () => {
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const writer = new BatchWriter({ clickhouse: mockClickHouse(insertFn), flushSize: 5 });
    writer.enqueue([makeEvent("evt-a")]);
    await writer.flush();
    writer.enqueue([makeEvent("evt-b")]);
    await writer.flush();
    const [a, b] = insertFn.mock.calls.map(
      (c) =>
        (c[0] as { clickhouse_settings: Record<string, unknown> }).clickhouse_settings
          .insert_deduplication_token,
    );
    expect(a).not.toBe(b);
  });
});
