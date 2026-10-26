import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BatchWriter,
  ISOLATION_INSERTS_PER_FLUSH,
  RESOURCE_ERROR_FLUSHES,
  rowErrorName,
  rowsToDrop,
} from "../lib/batch-writer.js";
import type { EnrichedEvent } from "../lib/event-enricher.js";
import { mapToolRegistryRow } from "../lib/tool-registry.js";

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
      // lets ClickHouse drop a retried batch it already stored (#90). Without
      // parallel parsing the row ClickHouse names is the first refused one.
      clickhouse_settings: {
        async_insert: 0,
        input_format_parallel_parsing: 0,
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
// Failed inserts: rows ClickHouse refuses, unrecognised errors, outages
// ---------------------------------------------------------------------------

/** How the fake ClickHouse fails a row. */
type Failure = "refused" | "unrecognised" | null;

interface InsertCall {
  ids: string[];
  token: string;
}

interface InsertArgs {
  values: Array<Record<string, unknown>>;
  clickhouse_settings: { insert_deduplication_token: string };
}

interface FakeOptions {
  /**
   * ClickHouse names the first failing row ("(at row N)"), as 26.8 does
   * without parallel parsing. "last": it names the last one, as it can with
   * parallel parsing. Default true (the first).
   */
  namesRow?: boolean | "last";
  /** Whether ClickHouse answers a ping. Default: it does. */
  answers?: () => boolean;
  /** An error for the whole insert, before any row is read (an outage, a resource limit). */
  insertError?: (values: Array<Record<string, unknown>>) => Error | null;
  /** The row's id in the inserted values. Default: event_id. */
  idOf?: (value: Record<string, unknown>) => string;
}

/**
 * ClickHouse's message for a refused row, as on 26.8: a refused number
 * ("…before: '<the input after the error>'") ends with its own "(at row
 * N)" and a new line. `quoted`: the input it quotes, which a row's own text
 * can make contain "(at row 1)".
 */
function rowError(
  failure: Exclude<Failure, null>,
  at: number | null,
  quoted = '1e+21,"source":"server"}',
): ClickHouseError {
  const where =
    at === null ? "" : `: (at row ${at})\n: While executing JSONEachRowRowInputFormat. `;
  return failure === "refused"
    ? new ClickHouseError({
        message: `Cannot parse input: expected ',' before: '${quoted}'${where}`,
        code: "27",
        type: "CANNOT_PARSE_INPUT_ASSERTION_FAILED",
      })
    : new ClickHouseError({
        message: `Unexpected condition${where}`,
        code: "1002",
        type: "UNKNOWN_EXCEPTION",
      });
}

function connectionRefused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8123"), { code: "ECONNREFUSED" });
}

/**
 * A ClickHouse that stores every insert unless a row fails (`fails`) or the
 * insert does (`insertError`). Records the inserts with their tokens, and
 * the stored ids.
 */
function fakeClickHouse(fails: (id: string) => Failure, options: FakeOptions = {}) {
  const namesRow = options.namesRow ?? true;
  const idOf = options.idOf ?? ((v) => String(v.event_id));
  const calls: InsertCall[] = [];
  const stored: string[] = [];
  const storedSet = new Set<string>();
  const insert = vi.fn(async (params: InsertArgs) => {
    const ids = params.values.map(idOf);
    calls.push({ ids, token: params.clickhouse_settings.insert_deduplication_token });
    const whole = options.insertError?.(params.values);
    if (whole) throw whole;
    const failing = ids.flatMap((id, i) => (fails(id) ? [i] : []));
    if (failing.length > 0) {
      const first = failing[0];
      const named = namesRow === "last" ? (failing.at(-1) ?? first) : first;
      // A row whose text holds "(at row 1)", quoted after the refused value.
      const quoted = ids[first].includes("quoted")
        ? '1e+21,"error_message":"x (at row 1) y"}\\n{"event_id":"…'
        : undefined;
      throw rowError(
        fails(ids[first]) as Exclude<Failure, null>,
        namesRow ? named + 1 : null,
        quoted,
      );
    }
    stored.push(...ids);
    for (const id of ids) storedSet.add(id);
  });
  const ping = vi.fn(async () =>
    (options.answers?.() ?? true)
      ? { success: true as const }
      : { success: false as const, error: connectionRefused() },
  );
  return {
    client: { insert, ping } as unknown as ClickHouseClient,
    insert,
    ping,
    calls,
    stored,
    storedSet,
  };
}

function ev(id: string, project = "proj-1"): EnrichedEvent {
  return { ...makeEvent(id), project_id: project };
}

function events(prefix: string, n: number, project = "proj-1"): EnrichedEvent[] {
  return Array.from({ length: n }, (_, i) => ev(`${prefix}-${i}`, project));
}

const isBad = (id: string): Failure => (id.startsWith("bad") ? "refused" : null);

/** A flush, with any retry backoff run through (fake timers). */
async function flushThrough(writer: BatchWriter): Promise<void> {
  const flushing = writer.flush();
  await vi.advanceTimersByTimeAsync(10_000);
  await flushing;
}

/** The events of the "Dropped N events …" warnings so far. */
function droppedCount(warn: ReturnType<typeof vi.fn>): number {
  return warn.mock.calls
    .filter(([message]) => String(message).startsWith("Dropped"))
    .reduce((n, [, details]) => n + (details as { dropped: number }).dropped, 0);
}

describe("BatchWriter: rows ClickHouse refuses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does one insert of the whole batch when it succeeds, with the rows as buffered", async () => {
    const ch = fakeClickHouse(() => null);
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000 });
    const rows = events("ok", 500);
    writer.enqueue(rows);
    await writer.flush();

    expect(ch.insert).toHaveBeenCalledTimes(1);
    expect(ch.ping).not.toHaveBeenCalled();
    const [params] = ch.insert.mock.calls[0];
    expect(params.values).toHaveLength(500);
    // No copy and no mapping: the insert it was before.
    params.values.forEach((value, i) => expect(value).toBe(rows[i]));
    expect(writer.bufferedCount).toBe(0);
  });

  it("isolates a refused row ClickHouse names in four inserts, and drops it once refused alone", async () => {
    const ch = fakeClickHouse((id) => (id === "evt-637" ? "refused" : null));
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000, logger: { warn } });
    writer.enqueue(events("evt", 1_000));
    await writer.flush();

    // The batch (refused at row 638), the 637 rows before it, the row alone, the rest.
    expect(ch.calls.map((c) => c.ids.length)).toEqual([1_000, 637, 1, 362]);
    expect(ch.stored).toHaveLength(999);
    expect(ch.stored).not.toContain("evt-637");
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "Dropped 1 events ClickHouse refused twice",
      {
        dropped: 1,
        event_ids: ["evt-637"],
        project_ids: ["proj-1"],
        errors: ["CANNOT_PARSE_INPUT_ASSERTION_FAILED"],
      },
    ]);
  });

  it("isolates a refused row in halves when ClickHouse names none, and drops it when refused a second time", async () => {
    const ch = fakeClickHouse((id) => (id === "evt-637" ? "refused" : null), { namesRow: false });
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000, logger: { warn } });
    writer.enqueue(events("evt", 1_000));
    await writer.flush();

    expect(ch.stored).toHaveLength(999);
    // The failed insert, then two per level down to the row: 2·⌈log2 1000⌉ + 1.
    expect(ch.insert.mock.calls.length).toBeLessThanOrEqual(21);
    // Refused once, alone: kept apart, not counted towards backpressure.
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    await writer.flush();
    expect(ch.calls.at(-1)?.ids).toEqual(["evt-637"]);
    expect(writer.keptCount).toBe(0);
    expect(warn.mock.calls[0][1]).toMatchObject({ dropped: 1, event_ids: ["evt-637"] });
  });

  it("isolates k refused rows among n in one flush", async () => {
    const bad = new Set(["evt-3", "evt-404", "evt-405", "evt-998"]);
    const ch = fakeClickHouse((id) => (bad.has(id) ? "refused" : null));
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000, logger: { warn } });
    writer.enqueue(events("evt", 1_000));
    await writer.flush();

    expect(ch.stored).toHaveLength(996);
    expect(ch.stored.filter((id) => bad.has(id))).toEqual([]);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(0);
    // Per refused row: the rows before it, the row alone, the rest.
    expect(ch.insert.mock.calls.length).toBeLessThanOrEqual(1 + 3 * bad.size);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("Dropped 4 events ClickHouse refused twice");
    expect(new Set((warn.mock.calls[0][1] as { event_ids: string[] }).event_ids)).toEqual(bad);
  });

  it("gives each part of a split batch a token of its own", async () => {
    const ch = fakeClickHouse((id) => (id === "evt-1" ? "refused" : null));
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue(events("evt", 4));
    await writer.flush();

    expect(ch.calls.map((c) => c.ids)).toEqual([
      ["evt-0", "evt-1", "evt-2", "evt-3"],
      ["evt-0"],
      ["evt-1"],
      ["evt-2", "evt-3"],
    ]);
    expect(new Set(ch.calls.map((c) => c.token)).size).toBe(4);
  });

  it("drops a row refused a second time even when the flush stored nothing", async () => {
    const ch = fakeClickHouse(isBad, { namesRow: false });
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100, logger: { warn } });
    writer.enqueue(events("bad", 4));
    await writer.flush();
    expect(ch.stored).toEqual([]);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(4);

    await writer.flush();
    expect(writer.keptCount).toBe(0);
    expect(droppedCount(warn)).toBe(4);
  });

  it("keeps a row's refusal when the budget runs out before it is tried alone", async () => {
    // 40 refused rows ClickHouse names one at a time: two budgeted inserts
    // each (the row alone, the rest), so the budget ends after 32.
    const ch = fakeClickHouse(isBad);
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100, logger: { warn } });
    writer.enqueue(events("bad", 40));
    await writer.flush();
    expect(droppedCount(warn)).toBe(ISOLATION_INSERTS_PER_FLUSH / 2);
    expect(writer.keptCount).toBe(40 - ISOLATION_INSERTS_PER_FLUSH / 2);

    // bad-32 was refused in the batch and kept with that refusal: refused
    // alone in the next flush, it is dropped at once.
    const before = ch.calls.length;
    await writer.flush();
    const alone = ch.calls.slice(before).filter((c) => c.ids.length === 1 && c.ids[0] === "bad-32");
    expect(alone).toHaveLength(1);
    expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({
      event_ids: expect.arrayContaining(["bad-32"]),
    });
    // The last one, bad-39, was the whole rest of its batch: refused alone
    // once in this flush, it is dropped in the next.
    expect(writer.keptCount).toBe(1);
    expect(droppedCount(warn)).toBe(39);
    await writer.flush();
    expect(writer.keptCount).toBe(0);
    expect(droppedCount(warn)).toBe(40);
  });

  it("spends at most ISOLATION_INSERTS_PER_FLUSH inserts per flush sorting rows out, oldest kept rows first", async () => {
    const ch = fakeClickHouse(isBad, { namesRow: false });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000 });
    writer.enqueue(events("bad-old", 1_000));
    await writer.flush();
    expect(ch.insert.mock.calls.length).toBe(1 + ISOLATION_INSERTS_PER_FLUSH);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(1_000);

    writer.enqueue(events("bad-new", 10));
    const before = ch.calls.length;
    await writer.flush();
    const calls = ch.calls.slice(before);
    // The new batch's own insert is not budgeted; every budgeted insert went
    // to the rows kept earlier.
    expect(calls).toHaveLength(1 + ISOLATION_INSERTS_PER_FLUSH);
    expect(calls.filter((c) => c.ids.some((id) => id.startsWith("bad-new")))).toHaveLength(1);
  });

  it("caps the rows kept apart, dropping the oldest with a warning", async () => {
    const ch = fakeClickHouse(isBad, { namesRow: false });
    const warn = vi.fn();
    const writer = new BatchWriter({
      clickhouse: ch.client,
      flushSize: 2_000,
      maxKeptRows: 100,
      logger: { warn },
    });
    writer.enqueue(events("bad", 300));
    await writer.flush();
    expect(writer.keptCount).toBe(100);
    const eviction = warn.mock.calls.find(([m]) => String(m).includes("over the 100-event limit"));
    expect(eviction?.[1]).toMatchObject({ dropped: 200, project_ids: ["proj-1"] });
  });

  it("names only ClickHouse errors about the rows as such", () => {
    expect(rowErrorName(rowError("refused", 1))).toBe("CANNOT_PARSE_INPUT_ASSERTION_FAILED");
    expect(rowErrorName(rowError("unrecognised", null))).toBeNull();
    expect(
      rowErrorName(new ClickHouseError({ message: "x", code: "252", type: "TOO_MANY_PARTS" })),
    ).toBeNull();
    expect(rowErrorName(connectionRefused())).toBeNull();
    expect(rowErrorName("CANNOT_PARSE_NUMBER")).toBeNull();
  });

  it("sets apart a row the row mapper cannot map, and writes the others", async () => {
    const ch = fakeClickHouse(() => null);
    const warn = vi.fn();
    const writer = new BatchWriter({
      clickhouse: ch.client,
      logger: { warn },
      mapRow: (event) => {
        if (event.event_id === "evt-odd") throw new TypeError("unexpected row");
        return event;
      },
    });
    writer.enqueue([ev("evt-1"), ev("evt-odd"), ev("evt-2")]);
    await flushThrough(writer);
    expect(ch.stored).toEqual(["evt-1", "evt-2"]);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ event_ids: ["evt-odd"], errors: ["TypeError"] });
  });

  it("takes the last row named in the message: a row's own text quoted before it cannot choose it", async () => {
    // bad-quoted-49's value is quoted in the message with "(at row 1)" in it,
    // before ClickHouse's own "(at row 50)".
    const ch = fakeClickHouse(isBad);
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100, logger: { warn } });
    const rows = events("ok", 60);
    rows[49] = ev("bad-quoted-49");
    writer.enqueue(rows);
    await writer.flush();

    // The batch, the 49 rows before row 50, row 50 alone, the 10 after it.
    expect(ch.calls.map((c) => c.ids.length)).toEqual([60, 49, 1, 10]);
    expect(ch.stored).toHaveLength(59);
    expect(droppedCount(warn)).toBe(1);
  });

  it("sorts out the rows before a named row within the budget when they fail anyway", async () => {
    // ClickHouse names the last refused row (as it can with parallel
    // parsing): the rows before it hold refused rows too — 200 of them.
    const rows = events("ok", 1_000).map((r, i) => (i % 5 === 2 ? ev(`bad-${i}`) : r));
    const ch = fakeClickHouse(isBad, { namesRow: "last" });
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000, logger: { warn } });
    writer.enqueue(rows);
    await writer.flush();

    // Outside the budget: the batch, and the rows before a named row once per
    // part that was not itself such rows — at most one per budgeted insert.
    expect(ch.insert.mock.calls.length).toBeLessThanOrEqual(2 + 2 * ISOLATION_INSERTS_PER_FLUSH);
    expect(writer.bufferedCount).toBe(0);

    for (let f = 0; f < 40 && writer.keptCount > 0; f++) await writer.flush();
    expect(writer.keptCount).toBe(0);
    expect(ch.stored).toHaveLength(800);
    expect(droppedCount(warn)).toBe(200);
  });

  it(
    "stores the rows of small projects next to large ones and projects of refused rows",
    { timeout: 120_000 },
    async () => {
      // V4b: in each of 120 flushes, 15 large projects, 5 small valid projects
      // and 3 projects of refused rows.
      const ch = fakeClickHouse(isBad);
      const writer = new BatchWriter({ clickhouse: ch.client });
      const result = await load(writer, ch, 120, (f) => {
        const out: EnrichedEvent[][] = [];
        for (let p = 0; p < 15; p++) out.push(events(`ok-big-${f}-${p}`, 100, `proj-big-${p}`));
        for (let p = 0; p < 5; p++) {
          out.push(events(`ok-small-${f}-${p}`, 3, `proj-small-${p}`));
          out.push(events(`bad-${f}-${p}`, 12, `proj-refused-${p % 3}`));
        }
        return out;
      });
      expect(result.validMissing).toEqual([]);
      expect(result.backpressure).toEqual([]);
      expect(result.maxCounted).toBe(0);
    },
  );

  describe("rowsToDrop: which rows the cap drops", () => {
    const kept = (
      rows: EnrichedEvent[],
      since: number,
      { refusals = 0, failures = 0, failedAlone = false } = {},
    ) => ({ rows, refusals, failures, failedAlone, since });
    const ids = (rows: Set<EnrichedEvent>) => [...rows].map((r) => String(r.event_id)).sort();

    it("drops rows that failed on their own first, then other rows of their projects, a clean project's rows last", () => {
      const pieces = [
        // A clean project's rows set apart unsorted, the oldest of all.
        kept(events("clean", 6, "proj-clean"), 1),
        // A project with a refused row: that row, and its other rows.
        kept([ev("refused-1", "proj-noisy")], 2, { refusals: 1, failedAlone: true }),
        kept(events("noisy-rest", 3, "proj-noisy"), 2),
        // A row kept after an unrecognised error.
        kept([ev("odd-1", "proj-odd")], 3, { failures: 1, failedAlone: true }),
      ];
      expect(ids(rowsToDrop(pieces, 2))).toEqual(["odd-1", "refused-1"]);
      expect(ids(rowsToDrop(pieces, 5))).toEqual(
        ["noisy-rest-0", "noisy-rest-1", "noisy-rest-2", "odd-1", "refused-1"].sort(),
      );
      // Only then the clean project's, oldest first.
      expect(ids(rowsToDrop(pieces, 7))).toEqual(
        [
          "clean-0",
          "clean-1",
          "noisy-rest-0",
          "noisy-rest-1",
          "noisy-rest-2",
          "odd-1",
          "refused-1",
        ].sort(),
      );
    });

    it("takes only a row whose insert on its own failed as failed on its own", () => {
      const pieces = [
        // Rows kept after a server error: they never failed on their own.
        kept(events("retried", 5, "proj-clean"), 1, { failures: 1 }),
        kept([ev("retried-alone", "proj-clean")], 1, { failures: 1 }),
        // A row ClickHouse named in a batch, set apart before its insert on
        // its own (the budget ran out): its project counts as refusing.
        kept([ev("named-1", "proj-x")], 2, { refusals: 1 }),
        kept(events("x-rest", 2, "proj-x"), 2),
        // Refused on its own.
        kept([ev("refused-1", "proj-y")], 3, { refusals: 1, failedAlone: true }),
      ];
      expect(ids(rowsToDrop(pieces, 1))).toEqual(["refused-1"]);
      expect(ids(rowsToDrop(pieces, 4))).toEqual(
        ["named-1", "refused-1", "x-rest-0", "x-rest-1"].sort(),
      );
      expect(ids(rowsToDrop(pieces, 5))).toEqual(
        ["named-1", "refused-1", "retried-0", "x-rest-0", "x-rest-1"].sort(),
      );
    });

    it("counts as refusing a project with rows dropped in the flush", () => {
      const pieces = [kept(events("a", 3, "proj-a"), 1), kept(events("b", 3, "proj-b"), 2)];
      expect(ids(rowsToDrop(pieces, 2, new Set(["proj-b"])))).toEqual(["b-0", "b-1"]);
    });

    it("within a kind, drops from the project with the most rows, oldest first, so they take turns", () => {
      const pieces = [
        kept(events("few", 2, "proj-few"), 1),
        kept(events("many", 10, "proj-many"), 2),
      ];
      expect(ids(rowsToDrop(pieces, 8))).toEqual(
        ["many-0", "many-1", "many-2", "many-3", "many-4", "many-5", "many-6", "many-7"].sort(),
      );
      expect(rowsToDrop(pieces, 12).size).toBe(12);
      expect(rowsToDrop(pieces, 20).size).toBe(12);
    });
  });

  it("logs a drop at error level when the flush stored nothing and the rows come from several projects", async () => {
    const ch = fakeClickHouse(isBad);
    const warn = vi.fn();
    const error = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, logger: { warn, error } });
    writer.enqueue([...events("bad-a", 2, "proj-a"), ...events("bad-b", 2, "proj-b")]);
    await writer.flush();
    // The first of each project: refused among other rows and alone (the
    // other project first).
    expect(error).toHaveBeenCalledWith(
      "Dropped 2 events ClickHouse refused twice",
      expect.objectContaining({ dropped: 2, project_ids: ["proj-b", "proj-a"] }),
    );
    expect(warn).not.toHaveBeenCalled();
    await writer.flush(); // the second of each, refused alone twice
    expect(error).toHaveBeenCalledTimes(2);

    // One project: a warning.
    writer.enqueue(events("bad-c", 2, "proj-c"));
    await writer.flush();
    expect(warn).toHaveBeenCalledWith(
      "Dropped 1 events ClickHouse refused twice",
      expect.objectContaining({ project_ids: ["proj-c"] }),
    );
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("BatchWriter: unrecognised errors and outages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a batch counted while ClickHouse does not answer, retries it first as the same batch, and stores it when it is back", async () => {
    let down = true;
    const ch = fakeClickHouse(() => null, {
      answers: () => !down,
      insertError: () => (down ? connectionRefused() : null),
    });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue([ev("evt-a"), ev("evt-b")]);
    await flushThrough(writer);
    writer.enqueue([ev("evt-c")]);
    await flushThrough(writer); // still down: the kept batch fails, evt-c waits
    expect(ch.calls.at(-1)?.ids).toEqual(["evt-a", "evt-b"]);
    expect(writer.bufferedCount).toBe(3);
    expect(writer.keptCount).toBe(0);
    // Never split while ClickHouse does not answer.
    expect(ch.calls.every((c) => c.ids.length === 2)).toBe(true);

    down = false;
    await flushThrough(writer);
    expect(ch.stored).toEqual(["evt-a", "evt-b", "evt-c"]);
    const tokens = ch.calls.filter((c) => c.ids.includes("evt-a")).map((c) => c.token);
    expect(new Set(tokens).size).toBe(1);
    expect(writer.bufferedCount).toBe(0);
  });

  it("counts batches kept while ClickHouse does not answer towards backpressure", async () => {
    const ch = fakeClickHouse(() => null, {
      answers: () => false,
      insertError: () => connectionRefused(),
    });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 10, maxBufferSize: 10 });
    writer.enqueue(events("evt", 8));
    await flushThrough(writer);
    expect(writer.bufferedCount).toBe(8);
    expect(writer.enqueue(events("more", 3))).toBe(true);
    expect(writer.enqueue(events("more", 2))).toBe(false);
  });

  it("retries a batch with a resource error as it is, and splits it after RESOURCE_ERROR_FLUSHES flushes while ClickHouse answers", async () => {
    const memory = new ClickHouseError({
      message: "Memory limit exceeded",
      code: "241",
      type: "MEMORY_LIMIT_EXCEEDED",
    });
    const ch = fakeClickHouse(() => null, {
      insertError: (values) => (values.length > 2 ? memory : null),
    });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue(events("evt", 4));
    for (let f = 1; f < RESOURCE_ERROR_FLUSHES; f++) {
      await flushThrough(writer);
      expect(writer.bufferedCount).toBe(4);
    }
    expect(ch.calls.every((c) => c.ids.length === 4)).toBe(true);
    await flushThrough(writer);
    expect(ch.stored).toEqual(["evt-0", "evt-1", "evt-2", "evt-3"]);
    expect(writer.bufferedCount).toBe(0);
  });

  it("keeps a batch with a server error (TOO_MANY_PARTS) as it is, counted, without asking ClickHouse, and never splits it", async () => {
    let parts = true;
    const tooManyParts = new ClickHouseError({
      message: "Too many parts (3001)",
      code: "252",
      type: "TOO_MANY_PARTS",
    });
    const ch = fakeClickHouse(() => null, { insertError: () => (parts ? tooManyParts : null) });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue(events("evt", 4));
    for (let f = 0; f < 8; f++) await flushThrough(writer);
    expect(ch.ping).not.toHaveBeenCalled();
    expect(ch.calls).toHaveLength(8 * 3); // three attempts per flush
    expect(ch.calls.every((c) => c.ids.length === 4)).toBe(true);
    expect(writer.bufferedCount).toBe(4);

    parts = false;
    await flushThrough(writer);
    expect(ch.stored).toHaveLength(4);
  });

  it("ends the flush on a server error while sorting rows out; a refused row stays apart, the rest counted", async () => {
    let down = false;
    const ch = fakeClickHouse(isBad, {
      answers: () => !down,
      insertError: () => (down ? connectionRefused() : null),
    });
    ch.insert.mockImplementationOnce(async (params: InsertArgs) => {
      ch.calls.push({ ids: params.values.map((v) => String(v.event_id)), token: "" });
      throw rowError("refused", 4);
    });
    ch.insert.mockImplementationOnce(async (params: InsertArgs) => {
      // The rows before the named one are stored; then ClickHouse goes down.
      for (const v of params.values) ch.storedSet.add(String(v.event_id));
      ch.stored.push(...params.values.map((v) => String(v.event_id)));
      down = true;
    });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue([...events("ok", 3), ev("bad-1"), ...events("ok-more", 3)]);
    await flushThrough(writer);

    expect(ch.stored).toEqual(["ok-0", "ok-1", "ok-2"]);
    expect(writer.keptCount).toBe(1); // bad-1, refused once in the batch
    expect(writer.bufferedCount).toBe(3); // the rest, not tried: counted

    down = false;
    await flushThrough(writer);
    expect(ch.stored).toEqual(["ok-0", "ok-1", "ok-2", "ok-more-0", "ok-more-1", "ok-more-2"]);
    expect(writer.bufferedCount + writer.keptCount).toBe(0);
  });

  it("keeps a batch with a client-side timeout counted, as the same batch, while ClickHouse answers; splits it after RESOURCE_ERROR_FLUSHES flushes", async () => {
    // @clickhouse/client raises its request timeout as a plain Error, no code.
    const ch = fakeClickHouse(() => null, {
      insertError: (values) => (values.length > 2 ? new Error("Timeout error.") : null),
    });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 100 });
    writer.enqueue(events("evt", 4));
    for (let f = 1; f < RESOURCE_ERROR_FLUSHES; f++) {
      await flushThrough(writer);
      expect(writer.bufferedCount).toBe(4);
      expect(writer.keptCount).toBe(0);
    }
    expect(ch.calls.every((c) => c.ids.length === 4)).toBe(true);
    expect(new Set(ch.calls.map((c) => c.token)).size).toBe(1);

    await flushThrough(writer);
    expect(ch.stored).toHaveLength(4);
    expect(ch.calls.slice(-2).map((c) => c.ids.length)).toEqual([2, 2]);
  });

  it("stores a batch once when its insert reached ClickHouse but timed out on the way back", async () => {
    // A ClickHouse that stores each block once per token (the deduplication
    // window, migration 0014), and whose answers time out for two flushes.
    let slowFlushes = 2;
    const tokens = new Set<string>();
    const copies = new Map<string, number>();
    const insert = vi.fn(async (params: InsertArgs) => {
      const token = params.clickhouse_settings.insert_deduplication_token;
      if (!tokens.has(token)) {
        tokens.add(token);
        for (const v of params.values) {
          const id = String(v.event_id);
          copies.set(id, (copies.get(id) ?? 0) + 1);
        }
      }
      if (slowFlushes > 0) throw new Error("Timeout error.");
    });
    const client = {
      insert,
      ping: async () => ({ success: true as const }),
    } as unknown as ClickHouseClient;
    const writer = new BatchWriter({ clickhouse: client, flushSize: 2_000 });
    writer.enqueue(events("evt", 1_000));
    for (; slowFlushes > 0; slowFlushes--) await flushThrough(writer);
    await flushThrough(writer);

    const storedMoreThanOnce = [...copies.values()].filter((n) => n > 1).length;
    expect(storedMoreThanOnce).toBe(0);
    expect(tokens.size).toBe(1);
    expect(copies.size).toBe(1_000);
    expect(writer.bufferedCount + writer.keptCount).toBe(0);
  });

  it("does not count an outage towards splitting a batch that then times out: it is stored once", async () => {
    // ClickHouse down for 6 flushes (no answer to a ping), then two flushes
    // in which inserts are stored but their answers time out.
    let phase: "down" | "slow" | "ok" = "down";
    const tokens = new Set<string>();
    const copies = new Map<string, number>();
    const insert = vi.fn(async (params: InsertArgs) => {
      if (phase === "down") throw connectionRefused();
      const token = params.clickhouse_settings.insert_deduplication_token;
      if (!tokens.has(token)) {
        tokens.add(token);
        for (const v of params.values) {
          const id = String(v.event_id);
          copies.set(id, (copies.get(id) ?? 0) + 1);
        }
      }
      if (phase === "slow") throw new Error("Timeout error.");
    });
    const client = {
      insert,
      ping: async () =>
        phase === "down"
          ? { success: false as const, error: connectionRefused() }
          : { success: true as const },
    } as unknown as ClickHouseClient;
    const writer = new BatchWriter({ clickhouse: client, flushSize: 2_000 });
    writer.enqueue([...events("a", 500, "proj-a"), ...events("b", 500, "proj-b")]);
    for (let f = 0; f < 6; f++) await flushThrough(writer);
    phase = "slow";
    for (let f = 0; f < 2; f++) await flushThrough(writer);
    phase = "ok";
    for (let f = 0; f < 3; f++) await flushThrough(writer);

    const storedMoreThanOnce = [...copies.values()].filter((n) => n > 1).length;
    expect(storedMoreThanOnce).toBe(0);
    expect(copies.size).toBe(1_000);
    expect(tokens.size).toBe(1);
  });

  it("splits a failing batch of several projects into the named row's project and all the others", async () => {
    const rows = Array.from({ length: 20 }, (_, p) => events(`p${p}`, p + 1, `proj-${p}`)).flat();
    rows.push(ev("bad-1", "proj-19"));
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 1_000 });
    writer.enqueue(rows);
    await flushThrough(writer);

    // The batch; the 19 other projects in one insert; proj-19 split at
    // bad-1: its 20 rows before it, bad-1 alone.
    expect(ch.calls.map((c) => c.ids.length)).toEqual([211, 190, 20, 1]);
    expect(ch.stored).toHaveLength(rows.length - 1);
  });

  it("splits the projects in halves when ClickHouse names no row", async () => {
    const rows = Array.from({ length: 8 }, (_, p) => events(`p${p}`, 2, `proj-${p}`)).flat();
    rows.push(ev("bad-1", "proj-7"));
    const ch = fakeClickHouse(isBad, { namesRow: false });
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 1_000 });
    writer.enqueue(rows);
    await flushThrough(writer);

    // 8 projects → 4 + 4 → 2 + 2 → 1 + 1: proj-7 (3 rows) then in halves.
    expect(ch.calls.slice(0, 6).map((c) => c.ids.length)).toEqual([17, 8, 9, 4, 5, 2]);
    expect(ch.stored).toHaveLength(16);
  });

  it("splits a batch failing with an unrecognised error while ClickHouse answers, stores the rest and keeps the row apart, logging its error", async () => {
    const ch = fakeClickHouse((id) => (id === "odd-1" ? "unrecognised" : null), {
      namesRow: false,
    });
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, flushSize: 2_000, logger: { warn } });
    writer.enqueue([...events("ok", 500), ev("odd-1"), ...events("ok-more", 499)]);
    await flushThrough(writer);

    expect(ch.stored).toHaveLength(999);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({
      kept: 1,
      event_ids: ["odd-1"],
      project_ids: ["proj-1"],
      errors: ["UNKNOWN_EXCEPTION"],
    });

    // Not dropped for failing again; retried with a growing wait.
    const tries: number[] = [];
    for (let f = 1; f <= 20; f++) {
      const before = ch.calls.length;
      await flushThrough(writer);
      if (ch.calls.slice(before).some((c) => c.ids.includes("odd-1"))) tries.push(f);
    }
    expect(tries).toEqual([1, 3, 7, 15]);
    expect(writer.keptCount).toBe(1);
  });
});

describe("BatchWriter: shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the rows of a flush still running as in flight, until they are stored, dropped or kept", async () => {
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client });
    const insert = ch.insert.getMockImplementation();
    if (!insert) throw new Error("no insert");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const atFourth = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let n = 0;
    ch.insert.mockImplementation(async (params: InsertArgs) => {
      n++;
      if (n === 4) {
        reached();
        await gate;
      }
      return insert(params);
    });
    expect(writer.inFlightCount).toBe(0);
    writer.enqueue([...events("ok-a", 4), ev("bad-1"), ...events("ok-b", 5)]);
    const flushing = writer.flush();
    // The batch refused; the 4 rows before bad-1 stored; bad-1 refused alone
    // and dropped; the 5 after it in an insert that has not finished.
    await atFourth;
    expect(writer.inFlightCount).toBe(5);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(0);
    release();
    await flushing;
    expect(writer.inFlightCount).toBe(0);
    expect(ch.stored).toHaveLength(9);
  });

  it("writes the events batched with refused rows and drops the refused rows, logging that", async () => {
    const ch = fakeClickHouse(isBad, { namesRow: false });
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, logger: { warn } });
    writer.enqueue([...events("ok", 3), ev("bad-1"), ...events("ok-more", 3)]);
    await writer.shutdown(10_000);

    expect(ch.stored).toHaveLength(6);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(0);
    // bad-1 was refused alone twice: in the first flush and in the second.
    expect(ch.calls.filter((c) => c.ids.length === 1 && c.ids[0] === "bad-1")).toHaveLength(2);
    expect(warn.mock.calls.map(([m]) => m)).toEqual(["Dropped 1 events ClickHouse refused twice"]);
  });

  it("writes valid events left in parts not yet sorted out behind refused rows, flushing while that gets anywhere", async () => {
    // 200 refused rows ahead of 50 valid events, and no named rows: one
    // flush cannot sort them out within its budget.
    const ch = fakeClickHouse(isBad, { namesRow: false });
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, logger: { warn } });
    writer.enqueue([...events("bad", 200), ...events("ok", 50)]);
    await writer.shutdown(10_000);

    expect(ch.stored.filter((id) => id.startsWith("ok"))).toHaveLength(50);
    expect(writer.bufferedCount).toBe(0);
    expect(writer.keptCount).toBe(0);
    expect(droppedCount(warn)).toBe(200);
    expect(warn.mock.calls.filter(([m]) => String(m).startsWith("Shutdown"))).toEqual([]);
  });

  it("keeps flushing until the deadline while ClickHouse does not answer, and logs the events left", async () => {
    vi.useFakeTimers();
    const ch = fakeClickHouse(() => null, {
      answers: () => false,
      insertError: () => connectionRefused(),
    });
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, logger: { warn } });
    writer.enqueue(events("evt", 2));
    const stopping = writer.shutdown(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await stopping;

    // Three attempts per flush (1 s, 2 s apart) and a 1 s pause: three flushes in 10 s.
    expect(ch.insert.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(warn).toHaveBeenLastCalledWith(
      "Shutdown timeout: 2 events not written by the deadline, dropped",
    );
  });

  it("drops rows kept after an unrecognised error that are not due before the deadline, and says so", async () => {
    const ch = fakeClickHouse((id) => (id === "odd-1" ? "unrecognised" : null));
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, logger: { warn } });
    writer.enqueue([ev("ok-1"), ev("odd-1")]);
    await writer.shutdown(10_000);
    expect(ch.stored).toEqual(["ok-1"]);
    expect(warn).toHaveBeenLastCalledWith(
      "Shutdown: 1 events kept apart after failed inserts, dropped",
      { event_ids: ["odd-1"], project_ids: ["proj-1"] },
    );
  });
});

// ---------------------------------------------------------------------------
// Loads: valid events are stored in every flush, and rows set aside never
// make ingest refuse events (backpressure)
// ---------------------------------------------------------------------------

interface LoadResult {
  /** Flushes before which an enqueue was refused (backpressure). */
  backpressure: number[];
  /** Flushes after which a valid event enqueued for them was not stored. */
  validMissing: number[];
  maxCounted: number;
  maxKept: number;
}

/** `flushes` flushes, one second apart; `requests(f)` are enqueued before flush f. */
async function load(
  writer: BatchWriter,
  ch: ReturnType<typeof fakeClickHouse>,
  flushes: number,
  requests: (f: number) => EnrichedEvent[][],
  isValid: (id: string) => boolean = (id) => !id.startsWith("bad") && !id.startsWith("odd"),
  idOf: (row: EnrichedEvent) => string = (row) => String(row.event_id),
): Promise<LoadResult> {
  const result: LoadResult = { backpressure: [], validMissing: [], maxCounted: 0, maxKept: 0 };
  for (let f = 1; f <= flushes; f++) {
    const valid: string[] = [];
    for (const request of requests(f)) {
      if (writer.enqueue(request)) result.backpressure.push(f);
      else valid.push(...request.map(idOf).filter(isValid));
    }
    await flushThrough(writer);
    if (valid.some((id) => !ch.storedSet.has(id))) result.validMissing.push(f);
    result.maxCounted = Math.max(result.maxCounted, writer.bufferedCount);
    result.maxKept = Math.max(result.maxKept, writer.keptCount ?? 0);
  }
  return result;
}

// Up to 600 flushes of up to 9,020 rows each, through a fake ClickHouse.
describe("BatchWriter under a stream of rows it cannot store", { timeout: 120_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A: 200 refused rows per flush and nothing else: dropped, never filling the buffer", async () => {
    const ch = fakeClickHouse(isBad);
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: ch.client, logger: { warn } });
    const result = await load(writer, ch, 600, (f) => [events(`bad-${f}`, 200, "proj-a")]);

    expect(result.backpressure).toEqual([]);
    expect(result.maxCounted).toBe(0);
    expect(result.maxKept).toBeLessThanOrEqual(1_000);
    expect(droppedCount(warn)).toBeGreaterThan(0);

    // Once they stop, the rows kept apart are settled within a few flushes.
    const drain = await load(writer, ch, 40, () => []);
    expect(drain.backpressure).toEqual([]);
    expect(writer.keptCount).toBe(0);
  });

  it("B: 500 refused rows of one project ahead of 5 valid events of another: the valid ones are stored in every flush", async () => {
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client });
    const result = await load(writer, ch, 200, (f) => [
      events(`bad-${f}`, 500, "proj-noisy"),
      events(`ok-${f}`, 5, "proj-quiet"),
    ]);
    expect(result.validMissing).toEqual([]);
    expect(result.backpressure).toEqual([]);
  });

  /** n valid events with k refused ones spread among them, of one project. */
  function mixed(f: number, valid: number, refused: number): EnrichedEvent[] {
    const rows = events(`ok-${f}`, valid);
    const step = Math.floor(valid / refused);
    for (let i = refused - 1; i >= 0; i--) rows.splice(i * step + 7, 0, ev(`bad-${f}-${i}`));
    return rows;
  }

  it("C: 9,000 valid events and 20 refused rows per flush, one project: every valid event stored in its flush", async () => {
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client });
    const result = await load(writer, ch, 30, (f) => [mixed(f, 9_000, 20)]);
    expect(result.validMissing).toEqual([]);
    expect(result.backpressure).toEqual([]);
    expect(result.maxCounted).toBe(0);
  });

  it("D: 3,000 valid events and 5 refused rows per flush, one project: every valid event stored in its flush", async () => {
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client });
    const result = await load(writer, ch, 120, (f) => [mixed(f, 3_000, 5)]);
    expect(result.validMissing).toEqual([]);
    expect(result.backpressure).toEqual([]);
    expect(result.maxCounted).toBe(0);
  });

  it("E: 1,000 refused rows per flush from one project for 150 flushes, 20 valid events per flush from another: stored in every flush, and the rest settles after", async () => {
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client });
    // 20 requests of 50 refused rows, each followed by one valid event.
    const burst = (f: number) =>
      Array.from({ length: 20 }, (_, r) => [
        events(`bad-${f}-${r}`, 50, "proj-noisy"),
        [ev(`ok-${f}-${r}`, "proj-quiet")],
      ]).flat();
    const during = await load(writer, ch, 150, burst);
    expect(during.validMissing).toEqual([]);
    expect(during.backpressure).toEqual([]);
    expect(during.maxKept).toBeLessThanOrEqual(1_000);

    const after = await load(writer, ch, 50, (f) => [events(`ok-after-${f}`, 20, "proj-quiet")]);
    expect(after.validMissing).toEqual([]);
    expect(writer.keptCount).toBe(0);
  });

  it("F: the tool registry writer (flushSize 100, buffer 1,000) takes valid rows after 1,000 refused ones", async () => {
    const tool = (name: string): EnrichedEvent => ({
      ...ev(`evt-${name}`),
      event_type: "tool_discovery",
      tool_name: name,
    });
    const ch = fakeClickHouse(isBad, { idOf: (v) => String(v.tool_name) });
    const writer = new BatchWriter({
      clickhouse: ch.client,
      table: "tool_registry",
      mapRow: mapToolRegistryRow,
      flushIntervalMs: 5_000,
      flushSize: 100,
      maxBufferSize: 1_000,
    });
    const refused = await load(
      writer,
      ch,
      10,
      (f) => [Array.from({ length: 100 }, (_, i) => tool(`bad-${f}-${i}`))],
      () => false,
      (row) => String(row.tool_name),
    );
    expect(refused.backpressure).toEqual([]);

    const valid = await load(
      writer,
      ch,
      5,
      (f) => [Array.from({ length: 50 }, (_, i) => tool(`search-${f}-${i}`))],
      () => true,
      (row) => String(row.tool_name),
    );
    expect(valid.backpressure).toEqual([]);
    expect(valid.validMissing).toEqual([]);
  });

  it("one project with a refused row per flush among 200 clean projects of 10 events: every valid event stored in its flush", async () => {
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client });
    const result = await load(writer, ch, 60, (f) => [
      ...Array.from({ length: 200 }, (_, p) => events(`ok-${f}-${p}`, 10, `proj-clean-${p}`)),
      [ev(`bad-${f}`, "proj-refusing")],
    ]);
    expect(result.validMissing).toEqual([]);
    expect(result.backpressure).toEqual([]);
    expect(result.maxCounted).toBe(0);
  });

  it("20 projects with a refused row per flush among 100 clean projects of 20 events: every valid event stored", async () => {
    const ch = fakeClickHouse(isBad);
    const writer = new BatchWriter({ clickhouse: ch.client });
    const sent: string[] = [];
    const result = await load(writer, ch, 60, (f) => {
      const requests = [
        ...Array.from({ length: 100 }, (_, p) => events(`ok-${f}-${p}`, 20, `proj-clean-${p}`)),
        ...Array.from({ length: 20 }, (_, p) => [ev(`bad-${f}-${p}`, `proj-refusing-${p}`)]),
      ];
      for (const request of requests) for (const row of request) sent.push(String(row.event_id));
      return requests;
    });
    await load(writer, ch, 40, () => []);
    expect(result.validMissing).toEqual([]);
    expect(sent.filter((id) => id.startsWith("ok") && !ch.storedSet.has(id))).toEqual([]);
    expect(writer.keptCount).toBe(0);
  });

  it("M1: one row failing with an unrecognised error every 5 flushes among 1,000 valid events per flush: every valid event stored", async () => {
    const ch = fakeClickHouse((id) => (id.startsWith("odd") ? "unrecognised" : null), {
      namesRow: false,
    });
    const writer = new BatchWriter({ clickhouse: ch.client });
    const result = await load(writer, ch, 150, (f) => {
      const rows = events(`ok-${f}`, 1_000);
      if (f % 5 === 0) rows.splice(500, 0, ev(`odd-${f}`));
      return [rows];
    });
    expect(result.validMissing).toEqual([]);
    expect(result.backpressure).toEqual([]);
    expect(result.maxCounted).toBe(0);
    // Kept apart, not dropped: 30 rows, retried with a growing wait.
    expect(writer.keptCount).toBe(30);
  });
});
