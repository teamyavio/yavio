import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BatchWriter,
  ISOLATION_INSERTS_PER_FLUSH,
  MAX_FAILED_FLUSHES_AHEAD,
  rowErrorName,
} from "../lib/batch-writer.js";
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

// ---------------------------------------------------------------------------
// Rows ClickHouse refuses, and inserts that fail for another reason
// ---------------------------------------------------------------------------

/** The error @clickhouse/client throws for a row a UInt column refuses. */
function refused(): ClickHouseError {
  return new ClickHouseError({
    message: "Unsigned type must not contain '-' symbol: (at row 1)",
    code: "72",
    type: "CANNOT_PARSE_NUMBER",
  });
}

/** An error not about the rows: a lost connection. */
function connectionLost(): Error {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

interface InsertCall {
  ids: string[];
  token: string;
}

interface InsertArgs {
  values: EnrichedEvent[];
  clickhouse_settings: { insert_deduplication_token: string };
}

/**
 * A ClickHouse that stores every insert unless `fails` returns an error for
 * one of its rows. Records the inserts with their tokens, and the stored ids.
 */
function fakeClickHouse(fails: (id: string) => Error | null) {
  const calls: InsertCall[] = [];
  const stored: string[] = [];
  const insert = vi.fn(async (params: InsertArgs) => {
    const ids = params.values.map((v) => String(v.event_id));
    calls.push({ ids, token: params.clickhouse_settings.insert_deduplication_token });
    for (const id of ids) {
      const error = fails(id);
      if (error) throw error;
    }
    stored.push(...ids);
  });
  return { client: { insert } as unknown as ClickHouseClient, insert, calls, stored };
}

function events(prefix: string, n: number): EnrichedEvent[] {
  return Array.from({ length: n }, (_, i) => makeEvent(`${prefix}-${i}`));
}

describe("BatchWriter: rows ClickHouse refuses", () => {
  // Real timers: a refused insert is not retried after a backoff, so these
  // flushes take no time.

  it("does one insert of the whole batch when it succeeds, with the rows as buffered", async () => {
    const ch = fakeClickHouse(() => null);
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000 });
    const rows = events("ok", 500);
    writer.enqueue(rows);
    await writer.flush();

    expect(ch.insert).toHaveBeenCalledTimes(1);
    const [params] = ch.insert.mock.calls[0];
    expect(params.values).toHaveLength(500);
    // No copy and no mapping: the insert it was before.
    params.values.forEach((value, i) => expect(value).toBe(rows[i]));
    expect(writer.bufferedCount).toBe(0);
  });

  it("isolates one refused row among 1,000: the others are stored, it is dropped with one warning", async () => {
    const ch = fakeClickHouse((id) => (id === "evt-637" ? refused() : null));
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000, logger: { warn } });
    writer.enqueue(events("evt", 1_000));
    await writer.flush();

    expect(ch.stored).toHaveLength(999);
    expect(ch.stored).not.toContain("evt-637");
    expect(writer.bufferedCount).toBe(0);
    // The failed insert, then two per level down to the row: 2·⌈log2 1000⌉ + 1.
    expect(ch.insert.mock.calls.length).toBeLessThanOrEqual(21);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({
      dropped: 1,
      event_ids: ["evt-637"],
      project_ids: ["proj-1"],
      errors: ["CANNOT_PARSE_NUMBER"],
    });
  });

  it("isolates k refused rows among n in one flush", async () => {
    const bad = new Set(["evt-3", "evt-404", "evt-405", "evt-998"]);
    const ch = fakeClickHouse((id) => (bad.has(id) ? refused() : null));
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000, logger: { warn } });
    writer.enqueue(events("evt", 1_000));
    await writer.flush();

    expect(ch.stored).toHaveLength(996);
    expect(ch.stored.filter((id) => bad.has(id))).toEqual([]);
    expect(writer.bufferedCount).toBe(0);
    expect(ch.insert.mock.calls.length).toBeLessThanOrEqual(1 + ISOLATION_INSERTS_PER_FLUSH);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^Dropped 4 events/);
    expect(new Set((warn.mock.calls[0][1] as { event_ids: string[] }).event_ids)).toEqual(bad);
  });

  it("gives each part of a split batch a token of its own", async () => {
    const ch = fakeClickHouse((id) => (id === "evt-1" ? refused() : null));
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue(events("evt", 4));
    await writer.flush();

    // [0–3] refused → [0, 1] refused → [0] stored, [1] refused → [2, 3] stored
    expect(ch.calls.map((c) => c.ids)).toEqual([
      ["evt-0", "evt-1", "evt-2", "evt-3"],
      ["evt-0", "evt-1"],
      ["evt-0"],
      ["evt-1"],
      ["evt-2", "evt-3"],
    ]);
    expect(new Set(ch.calls.map((c) => c.token)).size).toBe(5);
  });

  it("drops nothing when ClickHouse refuses every row, and tries the rows again next to rows it stores", async () => {
    let tableFixed = false;
    const ch = fakeClickHouse((id) => (!tableFixed && id.startsWith("evt") ? refused() : null));
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100, logger: { warn } });
    writer.enqueue(events("evt", 4));
    await writer.flush();

    expect(ch.stored).toEqual([]);
    expect(writer.bufferedCount).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^Kept 4 events/);

    // A flush that stores nothing does not try them again.
    const calls = ch.insert.mock.calls.length;
    await writer.flush();
    expect(ch.insert.mock.calls.length).toBe(calls);

    // Next to a row that is stored they are: dropped while still refused.
    writer.enqueue([makeEvent("ok-1")]);
    await writer.flush();
    expect(ch.stored).toEqual(["ok-1"]);
    expect(writer.bufferedCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toMatchObject({ dropped: 4 });

    // Kept rows the table takes again are stored.
    writer.enqueue([makeEvent("evt-kept")]);
    await writer.flush();
    expect(writer.bufferedCount).toBe(1);
    tableFixed = true;
    writer.enqueue([makeEvent("ok-2")]);
    await writer.flush();
    expect(ch.stored).toEqual(["ok-1", "ok-2", "evt-kept"]);
    expect(writer.bufferedCount).toBe(0);
  });

  it("spends at most ISOLATION_INSERTS_PER_FLUSH inserts per flush isolating rows, and keeps the rest", async () => {
    const ch = fakeClickHouse(() => refused());
    // Above the batch, so that enqueue does not start a flush of its own.
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000 });
    writer.enqueue(events("evt", 1_000));
    await writer.flush();
    expect(ch.insert.mock.calls.length).toBe(1 + ISOLATION_INSERTS_PER_FLUSH);
    expect(writer.bufferedCount).toBe(1_000);

    await writer.flush();
    expect(ch.insert.mock.calls.length).toBe(1 + 2 * ISOLATION_INSERTS_PER_FLUSH);
    expect(writer.bufferedCount).toBe(1_000);
  });

  it("returns from shutdown at once when only refused rows are left", async () => {
    const ch = fakeClickHouse(() => refused());
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, logger: { warn } });
    writer.enqueue(events("evt", 2));
    const started = Date.now();
    await writer.shutdown(10_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).toHaveBeenLastCalledWith("Shutdown timeout: 2 events dropped");
  });

  it("names only ClickHouse errors about the rows as such", () => {
    expect(rowErrorName(refused())).toBe("CANNOT_PARSE_NUMBER");
    expect(
      rowErrorName(new ClickHouseError({ message: "x", code: "252", type: "TOO_MANY_PARTS" })),
    ).toBeNull();
    expect(rowErrorName(connectionLost())).toBeNull();
    expect(rowErrorName("CANNOT_PARSE_NUMBER")).toBeNull();
  });

  it("keeps the rows when the row mapper throws", async () => {
    const ch = fakeClickHouse(() => null);
    const writer = new BatchWriter({
      clickhouse: ch.client,
      mapRow: () => {
        throw new TypeError("unexpected row");
      },
    });
    vi.useFakeTimers();
    try {
      writer.enqueue([makeEvent("evt-1")]);
      const flushing = writer.flush();
      await vi.advanceTimersByTimeAsync(10_000);
      await flushing;
    } finally {
      vi.useRealTimers();
    }
    expect(ch.insert).not.toHaveBeenCalled();
    expect(writer.bufferedCount).toBe(1);
  });
});

describe("BatchWriter: inserts that fail for another reason", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A flush, with its retries' backoff run through. */
  async function flushThrough(writer: BatchWriter): Promise<void> {
    const flushing = writer.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushing;
  }

  it("keeps rows that keep failing apart and retries them behind newer events after MAX_FAILED_FLUSHES_AHEAD flushes", async () => {
    // Every insert with this row fails, for a reason ClickHouse does not
    // name as the row's; every other insert succeeds.
    const ch = fakeClickHouse((id) => (id === "evt-stuck" ? connectionLost() : null));
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100, logger: { warn } });

    writer.enqueue([makeEvent("evt-stuck")]);
    await flushThrough(writer);
    expect(writer.bufferedCount).toBe(1);

    // Ahead of newer events for MAX_FAILED_FLUSHES_AHEAD flushes, as before:
    // a failed batch is retried first, and its failure ends the flush.
    const newer = Array.from({ length: MAX_FAILED_FLUSHES_AHEAD - 1 }, (_, i) =>
      makeEvent(`evt-new-${i}`),
    );
    for (const event of newer) {
      writer.enqueue([event]);
      await flushThrough(writer);
    }
    expect(ch.stored).toEqual([]);

    // Then behind them: the newer events are stored, the row is retried after.
    writer.enqueue([makeEvent("evt-last")]);
    await flushThrough(writer);
    expect(ch.stored).toEqual([...newer.map((e) => e.event_id), "evt-last"]);
    expect(writer.bufferedCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ events: 1, error: "ECONNRESET" });

    writer.enqueue([makeEvent("evt-after")]);
    await flushThrough(writer);
    expect(ch.stored).toContain("evt-after");
    expect(writer.bufferedCount).toBe(1);

    // Never in an insert with other rows, and the same token every time.
    const withStuck = ch.calls.filter((c) => c.ids.includes("evt-stuck"));
    expect(withStuck.every((c) => c.ids.length === 1)).toBe(true);
    expect(new Set(withStuck.map((c) => c.token)).size).toBe(1);
    // Three attempts per flush while ahead, one per flush behind.
    expect(withStuck).toHaveLength(3 * MAX_FAILED_FLUSHES_AHEAD + 2);
  });

  it("does not hold back newer events, or the events batched with it, for good behind a row that keeps failing", async () => {
    const ch = fakeClickHouse((id) => (id === "evt-stuck" ? connectionLost() : null));
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    // The first flush takes both: they fail together.
    writer.enqueue([makeEvent("evt-stuck"), makeEvent("evt-with-it")]);
    const newer: string[] = [];
    for (let i = 0; i < 12; i++) {
      newer.push(`evt-new-${i}`);
      writer.enqueue([makeEvent(`evt-new-${i}`)]);
      await flushThrough(writer);
    }
    expect([...ch.stored].sort()).toEqual([...newer, "evt-with-it"].sort());
    expect(writer.bufferedCount).toBe(1);
  });

  it("retries a batch kept after a failure as the same batch, then the newer events", async () => {
    let down = true;
    const ch = fakeClickHouse(() => (down ? connectionLost() : null));
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue([makeEvent("evt-a"), makeEvent("evt-b")]);
    await flushThrough(writer);
    writer.enqueue([makeEvent("evt-c")]);
    await flushThrough(writer); // still down: the kept batch fails, evt-c waits
    expect(ch.calls.at(-1)?.ids).toEqual(["evt-a", "evt-b"]);

    down = false;
    await flushThrough(writer);
    expect(ch.stored).toEqual(["evt-a", "evt-b", "evt-c"]);
    const tokens = ch.calls.filter((c) => c.ids.includes("evt-a")).map((c) => c.token);
    expect(new Set(tokens).size).toBe(1);
    expect(writer.bufferedCount).toBe(0);
  });

  it("counts kept rows towards backpressure", async () => {
    const ch = fakeClickHouse(() => connectionLost());
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 10, maxBufferSize: 10 });
    writer.enqueue(events("evt", 8));
    await flushThrough(writer);
    expect(writer.bufferedCount).toBe(8);
    expect(writer.enqueue(events("more", 3))).toBe(true);
    expect(writer.enqueue(events("more", 2))).toBe(false);
  });
});
