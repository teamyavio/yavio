import { createHash } from "node:crypto";
import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import type { EnrichedEvent } from "./event-enricher.js";

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_FLUSH_SIZE = 10_000;
const DEFAULT_MAX_BUFFER_SIZE = 100_000;
const MAX_RETRIES = 3;

/**
 * Flushes in a row that rows may fail to insert, for a reason other than
 * their content, and still be retried ahead of the events buffered after
 * them (as every failed batch was before). From the next flush on they are
 * retried after the newer events, with one attempt per flush, and split in
 * halves each time they fail again, so that rows failing for a reason of
 * their own that is not recognised as such (`ROW_ERROR_CODES`) can hold back
 * neither the rest of the buffer nor the rows they were batched with for
 * good. Nothing is dropped for such a failure.
 */
export const MAX_FAILED_FLUSHES_AHEAD = 5;

/**
 * Inserts a flush may spend finding the rows ClickHouse refuses (`write`).
 * One such row among 10,000 takes about 28, two about 50. What is not
 * isolated within the budget is kept and the search goes on in the next
 * flush, so a batch in which every row is refused (a schema the rows do not
 * fit) costs 64 failing inserts per flush, not twice its size.
 */
export const ISOLATION_INSERTS_PER_FLUSH = 64;

/** How many event ids, and project ids, a warning about refused rows names. */
const LOGGED_IDS = 5;
const LOGGED_PROJECTS = 10;

/**
 * ClickHouse errors about the inserted rows themselves: a value a column
 * cannot parse or hold, such as -1 or "1e+21" for a UInt32 or a string with
 * a lone surrogate escape. Inserting the same rows again fails the same way,
 * so a batch that fails with one of these is split until the refused rows
 * are found (`write`). Matched by code, which ClickHouse never renumbers;
 * the names are those of 26.8 (`errorCodeToName`, checked against the server
 * in insert-isolation.test.ts).
 *
 * Any other error is not about the rows — network, timeout, memory, too
 * many parts or simultaneous queries, but also a missing table or a refused
 * login — and keeps them for a later flush. A truncated request body
 * (ATTEMPT_TO_READ_AFTER_EOF, CANNOT_READ_ALL_DATA) is left out on purpose:
 * it says nothing about the rows.
 */
export const ROW_ERROR_CODES: ReadonlyMap<number, string> = new Map([
  [6, "CANNOT_PARSE_TEXT"],
  [25, "CANNOT_PARSE_ESCAPE_SEQUENCE"],
  [26, "CANNOT_PARSE_QUOTED_STRING"],
  [27, "CANNOT_PARSE_INPUT_ASSERTION_FAILED"],
  [38, "CANNOT_PARSE_DATE"],
  [41, "CANNOT_PARSE_DATETIME"],
  [53, "TYPE_MISMATCH"],
  [70, "CANNOT_CONVERT_TYPE"],
  [72, "CANNOT_PARSE_NUMBER"],
  [117, "INCORRECT_DATA"],
  [130, "CANNOT_READ_ARRAY_FROM_TEXT"],
  [131, "TOO_LARGE_STRING_SIZE"],
  [321, "VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE"],
  [349, "CANNOT_INSERT_NULL_IN_ORDINARY_COLUMN"],
  [376, "CANNOT_PARSE_UUID"],
  [407, "DECIMAL_OVERFLOW"],
  [441, "CANNOT_PARSE_DOMAIN_VALUE_FROM_STRING"],
  [467, "CANNOT_PARSE_BOOL"],
  [563, "CANNOT_READ_MAP_FROM_TEXT"],
  [632, "UNEXPECTED_DATA_AFTER_PARSED_VALUE"],
  [675, "CANNOT_PARSE_IPV4"],
  [676, "CANNOT_PARSE_IPV6"],
]);

/** The error's name when it is about the inserted rows (`ROW_ERROR_CODES`), else null. */
export function rowErrorName(err: unknown): string | null {
  if (!(err instanceof ClickHouseError)) return null;
  return ROW_ERROR_CODES.get(Number(err.code)) ?? null;
}

/**
 * A short label for an error that is not about the rows: the ClickHouse
 * error name, or a Node error code. Never the message, which may quote the
 * request.
 */
function errorLabel(err: unknown): string {
  if (err instanceof ClickHouseError) return err.type ?? `code ${err.code}`;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : err.name;
  }
  return typeof err;
}

/**
 * One token per batch, the same on every retry (#90). With the table's
 * non_replicated_deduplication_window (migration 0014), ClickHouse drops a
 * block it has already stored under this token, so a retry after an insert
 * that reached the server but failed on the way back is stored once.
 *
 * Hashed from each row's identity — event_id and the client's timestamp —
 * rather than from the whole serialised batch, which cost a second full
 * JSON.stringify per flush on top of the client's own (#114). A retry of
 * the same batch carries the same values; a clamped resend carries a new
 * timestamp (#90). Until #148 review round 5 `ingested_at` was part of the
 * identity, so that an SDK resend of a batch ingest had already written —
 * enriched again, with a new `ingested_at` — got a new token and was stored
 * again, to be collapsed by FINAL; now ClickHouse stamps `ingested_at` at
 * insert and the rows carry none. A resend that makes up a block of the
 * same rows gets the same token and is dropped by the window, which is the
 * same end state one merge earlier; one that lands in a block with other
 * rows is a different block, stored and collapsed by FINAL as before.
 * Sharing one serialisation between the token and the request body is not
 * an option with @clickhouse/client 1.x: validateInsertValues rejects a
 * non-object-mode (raw bytes) stream for JSONEachRow — raw streams are for
 * CSV/TSV-style formats only — and serialises object-mode rows itself. The
 * identity hash is the cheaper choice anyway: it serialises nothing.
 *
 * A part of a batch split to find refused rows (`write`) is a batch of its
 * own: its token is hashed from its own rows, and rows kept for a later
 * flush are kept together, so their retry carries the same token. A refused
 * insert has stored nothing: ClickHouse squashes an insert into blocks of up
 * to 1,048,449 rows or 256 MiB, a batch below that is one block, and a block
 * is refused whole.
 */
function batchToken(batch: ReadonlyArray<EnrichedEvent>): string {
  const hash = createHash("sha256");
  for (const event of batch) {
    hash.update(`${event.event_id}\t${event.timestamp}\n`);
  }
  return hash.digest("hex");
}

export interface BatchWriterLogger {
  warn: (msg: string, ...args: unknown[]) => void;
}

export interface BatchWriterOptions {
  clickhouse: ClickHouseClient;
  /** Target ClickHouse table. Defaults to `"events"`. */
  table?: string;
  /** Optional row mapper applied before insert. */
  mapRow?: (event: EnrichedEvent) => Record<string, unknown>;
  flushIntervalMs?: number;
  flushSize?: number;
  maxBufferSize?: number;
  logger?: BatchWriterLogger;
}

/** Rows waiting for another insert, kept together (one token, see batchToken). */
interface Pending {
  rows: EnrichedEvent[];
  /** Flushes in a row whose insert of these rows failed for a reason other than their content. */
  failures: number;
  /** A row ClickHouse refused in a flush that stored nothing (`settleRefused`). */
  refused?: true;
}

/** What one flush did. */
interface FlushRun {
  /** Inserts left for isolating refused rows. */
  budget: number;
  /** Rows stored. */
  stored: number;
  /** Rows ClickHouse refused on their own, with the error's name. */
  refused: Array<{ row: EnrichedEvent; error: string }>;
  /** An insert failed for a reason other than its rows: nothing more is tried. */
  halted: boolean;
  /** Rows retried behind newer events that failed again: kept after all others. */
  last: Pending[];
}

/**
 * Buffers events and writes them to ClickHouse in batches.
 *
 * A flush writes, in order:
 *
 * 1. rows that failed in fewer than MAX_FAILED_FLUSHES_AHEAD flushes in a
 *    row for a reason other than their content (a network error, a timeout,
 *    an overloaded server), each as the batch it was, with three attempts;
 * 2. the next `flushSize` buffered events;
 * 3. what earlier flushes kept: rows that failed in more flushes than that
 *    (one attempt each; when they fail again, split in halves and to the
 *    back of the queue), rows whose isolation ran out of budget, and
 *    refused rows kept by the rule below — within the flush's isolation
 *    budget.
 *
 * The first failure that is not about the rows ends the flush: everything
 * not tried yet stays where it is, and the buffer keeps filling until
 * `maxBufferSize`, where ingest answers 503 (backpressure). Rows kept this
 * way never share an insert with newer events, so a retry carries the same
 * deduplication token, and after MAX_FAILED_FLUSHES_AHEAD flushes rows that
 * keep failing hold back neither the buffer, nor the rows batched with them,
 * nor each other.
 *
 * An insert ClickHouse refuses because of a row (`ROW_ERROR_CODES`) is split
 * in halves, each inserted on its own, down to the single rows it refuses.
 * Those are dropped, with one warning per flush that names their event and
 * project ids and the error, never a value. They are dropped only when the
 * same flush stored other rows: when ClickHouse refuses every row, the
 * schema rather than the rows is at fault, and they are kept, to be tried
 * again in the next flush that stores rows.
 *
 * When every insert succeeds, a flush is one insert of the next batch, as
 * before: nothing is serialised or hashed twice.
 */
export class BatchWriter {
  private buffer: EnrichedEvent[] = [];
  /** Rows an earlier flush could not write, oldest first. */
  private pending: Pending[] = [];
  private pendingRows = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clickhouse: ClickHouseClient;
  private readonly table: string;
  private readonly mapRow?: (event: EnrichedEvent) => Record<string, unknown>;
  private readonly flushIntervalMs: number;
  private readonly flushSize: number;
  private readonly maxBufferSize: number;
  private readonly logger?: BatchWriterLogger;
  private inFlight: Promise<void> | null = null;

  constructor(options: BatchWriterOptions) {
    this.clickhouse = options.clickhouse;
    this.table = options.table ?? "events";
    this.mapRow = options.mapRow;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushSize = options.flushSize ?? DEFAULT_FLUSH_SIZE;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.logger = options.logger;
  }

  /**
   * Start the periodic flush timer.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.logger?.warn("Background flush failed", err);
      });
    }, this.flushIntervalMs);
  }

  /**
   * Enqueue events for batched writing.
   * Returns `true` if backpressure is active (buffer full), `false` otherwise.
   */
  enqueue(events: EnrichedEvent[]): boolean {
    if (this.bufferedCount + events.length > this.maxBufferSize) {
      return true; // backpressure
    }
    this.buffer.push(...events);

    if (this.buffer.length >= this.flushSize) {
      this.flush().catch((err) => {
        this.logger?.warn("Flush on size threshold failed", err);
      });
    }

    return false;
  }

  /**
   * Flush buffered events to ClickHouse.
   *
   * Resolves only once currently-buffered events have actually been
   * written (or kept after a failed insert) — callers like the shutdown
   * path rely on this as a completion guarantee, so a flush that is
   * already in flight is awaited instead of skipped.
   */
  async flush(): Promise<void> {
    await this.runFlush();
  }

  /** One flush, after the one in flight; null when there was nothing to write. */
  private async runFlush(): Promise<FlushRun | null> {
    while (this.inFlight) {
      await this.inFlight;
    }
    if (this.buffer.length === 0 && this.pending.length === 0) return null;

    const run: FlushRun = {
      budget: ISOLATION_INSERTS_PER_FLUSH,
      stored: 0,
      refused: [],
      halted: false,
      last: [],
    };
    this.inFlight = this.flushOnce(run);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    return run;
  }

  private async flushOnce(run: FlushRun): Promise<void> {
    // The kept rows stay counted (`pendingRows`, backpressure) until each
    // unit is taken for its insert, as the batch in flight is not counted.
    const pending = this.pending;
    this.pending = [];
    const isAhead = (p: Pending) => p.failures > 0 && p.failures < MAX_FAILED_FLUSHES_AHEAD;

    for (const p of pending.filter(isAhead)) {
      this.pendingRows -= p.rows.length;
      await this.write(p.rows, p.failures, run, false);
    }
    if (!run.halted && this.buffer.length > 0) {
      await this.write(this.buffer.splice(0, this.flushSize), 0, run, false);
    }
    for (const p of pending.filter((q) => !isAhead(q))) {
      this.pendingRows -= p.rows.length;
      // A refused row kept by settleRefused is tried again only in a flush
      // that has stored rows: until then it would be refused again, and
      // dropping it is decided in such a flush.
      if (p.refused && run.stored === 0) this.keep(p);
      else await this.write(p.rows, p.failures, run, true);
    }
    for (const p of run.last) this.keep(p);

    this.settleRefused(run);
  }

  /**
   * Insert `rows`. When ClickHouse refuses them because of a row, insert
   * each half on its own, down to single rows (`run.refused`). Rows that
   * cannot be tried now — after a failure that ends the flush, or with the
   * isolation budget spent (`isolating`: a half, or rows kept by an earlier
   * flush) — are kept for the next one.
   */
  private async write(
    rows: EnrichedEvent[],
    failures: number,
    run: FlushRun,
    isolating: boolean,
  ): Promise<void> {
    if (run.halted || (isolating && run.budget <= 0)) {
      this.keep({ rows, failures });
      return;
    }
    if (isolating) run.budget--;

    const failed = await this.insert(rows, failures >= MAX_FAILED_FLUSHES_AHEAD ? 1 : MAX_RETRIES);
    if (!failed) {
      run.stored += rows.length;
      return;
    }

    const rowError = rowErrorName(failed.error);
    if (rowError === null) {
      run.halted = true;
      const kept = { rows, failures: failures + 1 };
      if (kept.failures === MAX_FAILED_FLUSHES_AHEAD) {
        this.logger?.warn(
          `${rows.length} events failed to insert in ${MAX_FAILED_FLUSHES_AHEAD} flushes in a row; they are retried after newer events from now on`,
          { events: rows.length, error: errorLabel(failed.error) },
        );
      }
      if (failures < MAX_FAILED_FLUSHES_AHEAD) {
        this.keep(kept);
      } else if (rows.length === 1) {
        run.last.push(kept);
      } else {
        // Retried behind newer events and failed again: split, so that the
        // rows batched with one that keeps failing get through.
        const half = Math.ceil(rows.length / 2);
        run.last.push(
          { rows: rows.slice(0, half), failures: kept.failures },
          { rows: rows.slice(half), failures: kept.failures },
        );
      }
      return;
    }

    if (rows.length === 1) {
      run.refused.push({ row: rows[0], error: rowError });
      return;
    }
    const half = Math.ceil(rows.length / 2);
    await this.write(rows.slice(0, half), 0, run, true);
    await this.write(rows.slice(half), 0, run, true);
  }

  /**
   * Drop the rows ClickHouse refused on their own, with one warning — or,
   * when the flush stored nothing else, keep them: ClickHouse refusing every
   * row points at the table, not at the rows.
   */
  private settleRefused(run: FlushRun): void {
    if (run.refused.length === 0) return;
    const rows = run.refused.map((r) => r.row);
    const summary = {
      event_ids: rows.slice(0, LOGGED_IDS).map((r) => String(r.event_id)),
      project_ids: [...new Set(rows.map((r) => r.project_id))].slice(0, LOGGED_PROJECTS),
      errors: [...new Set(run.refused.map((r) => r.error))],
    };
    if (run.stored > 0) {
      this.logger?.warn(
        `Dropped ${rows.length} events ClickHouse refused to store; the events buffered with them were stored`,
        { dropped: rows.length, ...summary },
      );
      return;
    }
    for (const row of rows) this.keep({ rows: [row], failures: 0, refused: true });
    this.logger?.warn(
      `Kept ${rows.length} events ClickHouse refused to store: no other event was stored in this flush; they are tried again in the next flush that stores events`,
      { kept: rows.length, ...summary },
    );
  }

  private keep(p: Pending): void {
    this.pending.push(p);
    this.pendingRows += p.rows.length;
  }

  /** Insert `rows` with up to `attempts` tries; the last error, or undefined once stored. */
  private async insert(
    rows: EnrichedEvent[],
    attempts: number,
  ): Promise<{ error: unknown } | undefined> {
    let values: ReadonlyArray<Record<string, unknown>>;
    try {
      values = this.mapRow ? rows.map(this.mapRow) : rows;
    } catch (error) {
      return { error }; // not a ClickHouse error: the rows are kept
    }
    const dedupToken = batchToken(rows);
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.clickhouse.insert({
          table: this.table,
          values,
          format: "JSONEachRow",
          // Regular inserts only. async_insert is on by default from ClickHouse
          // 26.3 (#95); this writer already batches, so it gains nothing, and
          // async inserts deduplicate under different rules (#90).
          clickhouse_settings: { async_insert: 0, insert_deduplication_token: dedupToken },
        });
        return undefined;
      } catch (err) {
        lastError = err;
        // The same rows are refused the same way: no point in waiting.
        if (rowErrorName(err) !== null) break;
        if (attempt < attempts - 1) {
          const delay = 1000 * 2 ** attempt; // 1s, 2s, 4s
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return { error: lastError };
  }

  /**
   * Gracefully shutdown: stop timer and flush remaining events.
   * @param timeoutMs Maximum time to wait for flushing (default 10s).
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.bufferedCount > 0 && Date.now() < deadline) {
      const before = this.bufferedCount;
      const run = await this.runFlush();
      // Nothing written and no failure that may pass: what is left are rows
      // ClickHouse refuses, and flushing them again changes nothing.
      if (run && !run.halted && this.bufferedCount >= before) break;
    }
    if (this.bufferedCount > 0) {
      this.logger?.warn(`Shutdown timeout: ${this.bufferedCount} events dropped`);
    }
  }

  /** Events not written yet: buffered, or kept after a failed insert. */
  get bufferedCount(): number {
    return this.buffer.length + this.pendingRows;
  }
}
