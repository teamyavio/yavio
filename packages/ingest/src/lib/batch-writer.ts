import { createHash } from "node:crypto";
import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import type { EnrichedEvent } from "./event-enricher.js";

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_FLUSH_SIZE = 10_000;
const DEFAULT_MAX_BUFFER_SIZE = 100_000;
const DEFAULT_MAX_KEPT_ROWS = 1_000;
const MAX_RETRIES = 3;

/**
 * Inserts a flush may spend sorting out rows whose insert failed because of
 * their content (`write`): about two per row ClickHouse refuses, when it
 * names the row ("(at row N)"). The rows before a named row, and the
 * project groups of a failing batch (within PROJECT_GROUP_INSERTS_PER_FLUSH),
 * are inserted outside it. What a flush cannot sort out within the budget is
 * set apart for the next one.
 */
export const ISOLATION_INSERTS_PER_FLUSH = 64;

/** Project-group inserts a flush may make outside the isolation budget. */
export const PROJECT_GROUP_INSERTS_PER_FLUSH = 48;

/**
 * Flushes in a row a batch may fail with a resource error (memory, a time
 * limit) or an error without a ClickHouse code (a client-side timeout, a
 * reset connection) while ClickHouse answers a ping, before it is treated as
 * specific to its rows and split. Until then it is retried as it is, with
 * the same deduplication token: such an insert may have been stored.
 */
export const RESOURCE_ERROR_FLUSHES = 5;

/** A failing batch with rows of more projects is split into at most this many project groups. */
const MAX_PROJECT_GROUPS = 16;

/** Longest wait, in flushes, before a row kept after an unrecognised error is tried again. */
const MAX_UNRECOGNISED_BACKOFF_FLUSHES = 64;

/** How many event ids, and project ids, a warning names. */
const LOGGED_IDS = 5;
const LOGGED_PROJECTS = 10;

/**
 * Settings of every insert. `async_insert: 0`: regular inserts only;
 * async_insert is on by default from ClickHouse 26.3 (#95), this writer
 * batches itself, and async inserts deduplicate under different rules
 * (#90). `input_format_parallel_parsing: 0`: the row ClickHouse names in a
 * parse error ("(at row N)") is then the first refused row; with parallel
 * parsing it can be a later one. Not slower on 10,000-row inserts of 1 and
 * 5 KB rows (median 474 vs 490 ms, 1,070 vs 1,086 ms on 26.8).
 */
const INSERT_SETTINGS = { async_insert: 0, input_format_parallel_parsing: 0 } as const;

/**
 * ClickHouse errors about the inserted rows themselves: a value a column
 * cannot parse or hold, such as -1 or "1e+21" for a UInt32, a string with a
 * lone surrogate escape or a timestamp with 20 fractional digits. Inserting
 * the same rows again fails the same way. Matched by code, which ClickHouse
 * never renumbers; the names are those of 26.8 (`errorCodeToName`, checked
 * against the server in insert-isolation.test.ts).
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

/**
 * ClickHouse errors about the server, the connection or the table — never
 * about the rows: the batch is kept, counted towards backpressure, and
 * retried as it is, after a backoff. A truncated request body
 * (UNEXPECTED_END_OF_FILE, ATTEMPT_TO_READ_AFTER_EOF, CANNOT_READ_ALL_DATA)
 * is a transport failure. Names of 26.8, checked like ROW_ERROR_CODES.
 */
export const SERVER_ERROR_CODES: ReadonlyMap<number, string> = new Map([
  [3, "UNEXPECTED_END_OF_FILE"],
  [16, "NO_SUCH_COLUMN_IN_TABLE"],
  [32, "ATTEMPT_TO_READ_AFTER_EOF"],
  [33, "CANNOT_READ_ALL_DATA"],
  [60, "UNKNOWN_TABLE"],
  [81, "UNKNOWN_DATABASE"],
  [95, "CANNOT_READ_FROM_SOCKET"],
  [96, "CANNOT_WRITE_TO_SOCKET"],
  [164, "READONLY"],
  [192, "UNKNOWN_USER"],
  [194, "REQUIRED_PASSWORD"],
  [201, "QUOTA_EXCEEDED"],
  [202, "TOO_MANY_SIMULTANEOUS_QUERIES"],
  [203, "NO_FREE_CONNECTION"],
  [209, "SOCKET_TIMEOUT"],
  [210, "NETWORK_ERROR"],
  [218, "TABLE_IS_DROPPED"],
  [236, "ABORTED"],
  [242, "TABLE_IS_READ_ONLY"],
  [243, "NOT_ENOUGH_SPACE"],
  [252, "TOO_MANY_PARTS"],
  [279, "ALL_CONNECTION_TRIES_FAILED"],
  [394, "QUERY_WAS_CANCELLED"],
  [425, "SYSTEM_ERROR"],
  [439, "CANNOT_SCHEDULE_TASK"],
  [473, "DEADLOCK_AVOIDED"],
  [497, "ACCESS_DENIED"],
  [516, "AUTHENTICATION_FAILED"],
  [700, "USER_SESSION_LIMIT_EXCEEDED"],
  [749, "TCP_CONNECTION_LIMIT_REACHED"],
  [762, "HTTP_CONNECTION_LIMIT_REACHED"],
  [999, "KEEPER_EXCEPTION"],
  [1000, "POCO_EXCEPTION"],
]);

/**
 * Resource errors: the server's state, or a batch too large for it. Kept
 * and retried like SERVER_ERROR_CODES, and split after
 * RESOURCE_ERROR_FLUSHES flushes in a row while ClickHouse answers.
 */
export const RESOURCE_ERROR_CODES: ReadonlyMap<number, string> = new Map([
  [159, "TIMEOUT_EXCEEDED"],
  [173, "CANNOT_ALLOCATE_MEMORY"],
  [241, "MEMORY_LIMIT_EXCEEDED"],
  [776, "RESOURCE_LIMIT_EXCEEDED"],
  [777, "MEMORY_RESERVATION_KILLED"],
  [778, "MEMORY_RESERVATION_FAILED"],
]);

function clickhouseCode(err: unknown): number | null {
  if (!(err instanceof ClickHouseError)) return null;
  const code = Number(err.code);
  return Number.isInteger(code) ? code : null;
}

/** The error's name when it is about the inserted rows (`ROW_ERROR_CODES`), else null. */
export function rowErrorName(err: unknown): string | null {
  const code = clickhouseCode(err);
  return code === null ? null : (ROW_ERROR_CODES.get(code) ?? null);
}

/**
 * The 1-based position of the row ClickHouse names in its message, or null
 * when there is none or it is outside the batch. Only the number is read.
 *
 * The message can quote the input after the error position ("before:
 * '…'"), so a row's own text may contain "(at row 1)". ClickHouse puts its
 * own "(at row N)" after the quote and ends that line there (": (at row
 * 50)\n: While executing …"); a quoted newline is escaped ("\n" as two
 * characters). So the position is the last "(at row N)" that ends a line.
 * With parallel parsing off (INSERT_SETTINGS) it is the first refused row.
 */
export function namedRow(err: unknown, rows: number): number | null {
  if (!(err instanceof ClickHouseError)) return null;
  const matches = [...err.message.matchAll(/\(at row (\d+)\)(?=\n|$)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const at = Number(last[1]);
  return at >= 1 && at <= rows ? at : null;
}

/**
 * A short label for an error: the ClickHouse error name or code, or a Node
 * error code. Never the message, which can quote the rows.
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
 * A part of a batch split to sort out its rows (`split`) is a batch of its
 * own: its token is hashed from its own rows, and rows kept for a later
 * flush are kept together, so their retry carries the same token. A batch
 * whose insert failed without a ClickHouse code (a client-side timeout) may
 * have been stored; it is retried as it is, with its token, for
 * RESOURCE_ERROR_FLUSHES flushes before it is split. A refused insert has
 * stored nothing: ClickHouse squashes an insert into blocks of up to
 * 1,048,449 rows or 256 MiB, a batch below that is one block, and a block is
 * refused whole. A batch above 256 MiB can have its first blocks stored
 * before a later row is refused, and a batch split after timeouts may have
 * been stored; their parts carry new tokens, so those rows are stored twice
 * until a merge (or FINAL) collapses them.
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
  /** For drops that may point at the table rather than the rows; falls back to `warn`. */
  error?: (msg: string, ...args: unknown[]) => void;
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
  /** Rows kept apart while being sorted out (`kept`), at most. Defaults to 1,000. */
  maxKeptRows?: number;
  logger?: BatchWriterLogger;
}

/** Rows inserted together, with what their earlier inserts showed. */
interface Piece {
  rows: EnrichedEvent[];
  /**
   * Flushes in a row whose insert of these rows failed without ClickHouse
   * naming the rows: with a server or resource error, or without a code
   * (`retry`), or with an unrecognised error while ClickHouse answers
   * (`kept`, for the backoff).
   */
  failures: number;
  /** A single row: times ClickHouse refused it with a row error. */
  refusals: number;
  /** Of one project, or split by project already. */
  grouped: boolean;
  /** The flush from which a kept piece is tried again. */
  due: number;
  /** The flush in which its rows were first written, for the age of kept rows. */
  since: number;
}

/** How a piece is written. */
interface How {
  attempts: number;
  /** Counted against the flush's isolation budget. */
  budgeted: boolean;
  /** Where its rows go back to after a server error: `retry` (counted) or `kept`. */
  origin: "retry" | "kept";
  /**
   * Inserted outside the budget because it should succeed: the rows before
   * a named row. When it fails anyway, it is split within the budget.
   */
  expected?: boolean;
}

/** What one flush did. */
interface FlushRun {
  flush: number;
  /** Inserts left for sorting out rows. */
  budget: number;
  /** Project-group inserts left outside the budget. */
  groupInserts: number;
  /** Rows stored. */
  stored: number;
  /** An insert failed with a server error: nothing more is tried. */
  halted: boolean;
  /** Whether ClickHouse answered a ping, once asked in this flush. */
  answers?: boolean;
  /** Single rows ClickHouse refused a second time, dropped. */
  dropped: Array<{ row: EnrichedEvent; error: string }>;
  /** Single rows that failed with an unrecognised error while ClickHouse answers, kept apart. */
  unrecognised: Array<{ row: EnrichedEvent; error: string }>;
}

function summary(rows: EnrichedEvent[]) {
  return {
    event_ids: rows.slice(0, LOGGED_IDS).map((r) => String(r.event_id)),
    project_ids: [...new Set(rows.map((r) => r.project_id))].slice(0, LOGGED_PROJECTS),
  };
}

function oneProject(rows: EnrichedEvent[]): boolean {
  return rows.every((r) => r.project_id === rows[0].project_id);
}

/** Rows by project, in order of first appearance; beyond MAX_PROJECT_GROUPS the smallest go together. */
function byProject(rows: EnrichedEvent[]): EnrichedEvent[][] {
  const groups = new Map<string, EnrichedEvent[]>();
  for (const row of rows) {
    const group = groups.get(row.project_id);
    if (group) group.push(row);
    else groups.set(row.project_id, [row]);
  }
  const all = [...groups.values()];
  if (all.length <= MAX_PROJECT_GROUPS) return all;
  const largest = new Set(
    [...all].sort((a, b) => b.length - a.length).slice(0, MAX_PROJECT_GROUPS - 1),
  );
  return [...all.filter((g) => largest.has(g)), all.filter((g) => !largest.has(g)).flat()];
}

/**
 * Buffers events and writes them to ClickHouse in batches.
 *
 * A flush writes, in order:
 *
 * 1. batches kept after ClickHouse was unavailable or reported a server
 *    error (`retry`; counted towards backpressure), each as it was, with
 *    three attempts;
 * 2. rows kept apart while being sorted out (`kept`; not counted), oldest
 *    first, within the flush's isolation budget;
 * 3. the next `flushSize` buffered events.
 *
 * When an insert fails, the error decides:
 *
 * - A row error (`ROW_ERROR_CODES`): the batch is split — by project, then
 *   at the row ClickHouse names, else in halves — and each part inserted on
 *   its own. The other rows are stored. A single row ClickHouse refuses is
 *   kept apart and dropped when it is refused a second time, with one
 *   warning per flush (count, event ids, project ids, error names; never a
 *   value).
 * - A server error (`SERVER_ERROR_CODES`), any failure while ClickHouse
 *   does not answer a ping, and — for up to RESOURCE_ERROR_FLUSHES flushes
 *   in a row — a resource error or an error without a ClickHouse code (a
 *   client-side timeout): the batch is kept in `retry`, with its token, and
 *   the flush ends; everything not tried yet stays where it is, and the
 *   buffer fills until `maxBufferSize`, where ingest answers 503
 *   (backpressure). Nothing is split or dropped.
 * - An unlisted ClickHouse code while ClickHouse answers a ping, a resource
 *   or code-less error after RESOURCE_ERROR_FLUSHES flushes, or a row the
 *   row mapper cannot map: it is treated as specific to the batch and split
 *   like a row error; a single row that keeps failing is kept apart (not
 *   dropped for it), retried with a backoff of up to
 *   MAX_UNRECOGNISED_BACKOFF_FLUSHES flushes, and logged with its error.
 *
 * Rows kept apart never count towards backpressure, so they cannot make
 * ingest refuse other events. They are capped at `maxKeptRows`; beyond it
 * rows of the project with the most kept rows are dropped first, oldest
 * first, with a warning.
 *
 * When every insert succeeds, a flush is one insert of the next batch, as
 * before: nothing is serialised or hashed twice.
 */
export class BatchWriter {
  private buffer: EnrichedEvent[] = [];
  /** Batches kept after a server error, oldest first; counted. */
  private retry: Piece[] = [];
  private retryRows = 0;
  /** Rows kept apart while being sorted out; not counted towards backpressure. */
  private kept: Piece[] = [];
  private flushes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clickhouse: ClickHouseClient;
  private readonly table: string;
  private readonly mapRow?: (event: EnrichedEvent) => Record<string, unknown>;
  private readonly flushIntervalMs: number;
  private readonly flushSize: number;
  private readonly maxBufferSize: number;
  private readonly maxKeptRows: number;
  private readonly logger?: BatchWriterLogger;
  private inFlight: Promise<void> | null = null;

  constructor(options: BatchWriterOptions) {
    this.clickhouse = options.clickhouse;
    this.table = options.table ?? "events";
    this.mapRow = options.mapRow;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushSize = options.flushSize ?? DEFAULT_FLUSH_SIZE;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.maxKeptRows = options.maxKeptRows ?? DEFAULT_MAX_KEPT_ROWS;
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
   * Resolves only once the next batch has actually been written (or kept
   * after a failed insert) — callers like the shutdown path rely on this as
   * a completion guarantee, so a flush that is already in flight is awaited
   * instead of skipped.
   */
  async flush(): Promise<void> {
    await this.runFlush();
  }

  /** One flush, after the one in flight; null when there was nothing to write. */
  private async runFlush(): Promise<FlushRun | null> {
    while (this.inFlight) {
      await this.inFlight;
    }
    if (this.buffer.length === 0 && this.retry.length === 0 && this.kept.length === 0) {
      return null;
    }

    this.flushes++;
    const run: FlushRun = {
      flush: this.flushes,
      budget: ISOLATION_INSERTS_PER_FLUSH,
      groupInserts: PROJECT_GROUP_INSERTS_PER_FLUSH,
      stored: 0,
      halted: false,
      dropped: [],
      unrecognised: [],
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
    // The rows of a retried batch stay counted (backpressure) until it is
    // taken for its insert, as the batch in flight is not counted.
    const retry = this.retry;
    this.retry = [];
    for (const piece of retry) {
      this.retryRows -= piece.rows.length;
      await this.write(piece, run, { attempts: MAX_RETRIES, budgeted: false, origin: "retry" });
    }

    const kept = this.kept.sort((a, b) => a.since - b.since);
    this.kept = [];
    for (const piece of kept) {
      if (piece.due > run.flush) this.kept.push(piece);
      else await this.write(piece, run, { attempts: 1, budgeted: true, origin: "kept" });
    }

    if (!run.halted && this.buffer.length > 0) {
      const rows = this.buffer.splice(0, this.flushSize);
      await this.write(
        { rows, failures: 0, refusals: 0, grouped: false, due: 0, since: run.flush },
        run,
        { attempts: MAX_RETRIES, budgeted: false, origin: "retry" },
      );
    }

    this.settle(run);
  }

  /** Insert a piece; on a failure, keep it, split it or settle its row. */
  private async write(piece: Piece, run: FlushRun, how: How): Promise<void> {
    if (run.halted) {
      this.putBack(piece, how.origin);
      return;
    }
    if (how.budgeted) {
      if (run.budget <= 0) {
        this.kept.push(piece);
        return;
      }
      run.budget--;
    }

    const failed = await this.insert(piece.rows, how.attempts);
    if (!failed) {
      run.stored += piece.rows.length;
      return;
    }

    const kind = failed.mapping ? "batch" : await this.classify(failed.error, piece, run);
    if (kind === "server") {
      run.halted = true;
      this.putBack({ ...piece, failures: piece.failures + 1 }, how.origin);
      return;
    }
    if (piece.rows.length === 1) {
      this.settleRow(piece, kind, errorLabel(failed.error), run);
      return;
    }
    await this.split(piece, failed.error, kind, run, how);
  }

  /**
   * "row": ClickHouse refused the rows (ROW_ERROR_CODES). "server": the
   * server, the connection or the table failed, ClickHouse does not answer,
   * or — for RESOURCE_ERROR_FLUSHES flushes — a resource error or an error
   * without a ClickHouse code. "batch": an unlisted ClickHouse code while
   * ClickHouse answers, or a resource or code-less error after that.
   */
  private async classify(
    err: unknown,
    piece: Piece,
    run: FlushRun,
  ): Promise<"row" | "server" | "batch"> {
    if (rowErrorName(err) !== null) return "row";
    const code = clickhouseCode(err);
    if (code !== null && SERVER_ERROR_CODES.has(code)) return "server";
    if (!(await this.answers(run))) return "server";
    // No code (a client-side timeout: @clickhouse/client raises a plain
    // Error) or a resource error: the server may be slow, and the insert may
    // even have been stored. Retried as it is, with its token, first.
    if (code === null || RESOURCE_ERROR_CODES.has(code)) {
      return piece.failures + 1 < RESOURCE_ERROR_FLUSHES ? "server" : "batch";
    }
    return "batch";
  }

  /** Whether ClickHouse answers a ping; asked once per flush. */
  private async answers(run: FlushRun): Promise<boolean> {
    if (run.answers === undefined) {
      try {
        run.answers = (await this.clickhouse.ping()).success === true;
      } catch {
        run.answers = false;
      }
    }
    return run.answers;
  }

  /**
   * Split a failed batch: by project (when it holds more than one), then at
   * the row ClickHouse names, else in halves. The project groups (within
   * PROJECT_GROUP_INSERTS_PER_FLUSH) and the rows before a named row are
   * inserted outside the budget — the rows before it, because they parsed;
   * when they fail anyway, they are split within the budget. The named row
   * and the rest are budgeted.
   */
  private async split(
    piece: Piece,
    err: unknown,
    kind: "row" | "batch",
    run: FlushRun,
    how: How,
  ): Promise<void> {
    const part = (rows: EnrichedEvent[], refusals = 0): Piece => ({
      rows,
      failures: 0,
      refusals,
      grouped: oneProject(rows),
      due: 0,
      since: piece.since,
    });
    const origin = how.origin;
    const budgeted: How = { attempts: 1, budgeted: true, origin };

    if (!piece.grouped && !oneProject(piece.rows)) {
      for (const group of byProject(piece.rows)) {
        const free = run.groupInserts > 0;
        if (free) run.groupInserts--;
        await this.write(
          part(group),
          run,
          free ? { attempts: 1, budgeted: false, origin } : budgeted,
        );
      }
      return;
    }

    const at = namedRow(err, piece.rows.length);
    if (at !== null) {
      const before = piece.rows.slice(0, at - 1);
      const after = piece.rows.slice(at);
      if (before.length > 0) {
        // Outside the budget, once: a part that was itself expected to
        // succeed and failed is sorted out within the budget.
        await this.write(
          part(before),
          run,
          how.expected ? budgeted : { attempts: 1, budgeted: false, origin, expected: true },
        );
      }
      // Refused once in the batch: refused alone, it is dropped.
      await this.write(part([piece.rows[at - 1]], kind === "row" ? 1 : 0), run, budgeted);
      if (after.length > 0) await this.write(part(after), run, budgeted);
      return;
    }

    const half = Math.ceil(piece.rows.length / 2);
    await this.write(part(piece.rows.slice(0, half)), run, budgeted);
    await this.write(part(piece.rows.slice(half)), run, budgeted);
  }

  /** A single row that failed: dropped when refused a second time, else kept apart. */
  private settleRow(piece: Piece, kind: "row" | "batch", error: string, run: FlushRun): void {
    const [row] = piece.rows;
    if (kind === "row") {
      const refusals = piece.refusals + 1;
      if (refusals >= 2) run.dropped.push({ row, error });
      else this.kept.push({ ...piece, refusals, due: run.flush + 1 });
      return;
    }
    const failures = piece.failures + 1;
    const wait = Math.min(2 ** (failures - 1), MAX_UNRECOGNISED_BACKOFF_FLUSHES);
    this.kept.push({ ...piece, failures, due: run.flush + wait });
    run.unrecognised.push({ row, error });
  }

  /** After a server error: back to `retry` (counted), or to `kept` for rows kept apart or refused. */
  private putBack(piece: Piece, origin: How["origin"]): void {
    if (origin === "retry" && piece.refusals === 0) {
      this.retry.push(piece);
      this.retryRows += piece.rows.length;
    } else {
      this.kept.push(piece);
    }
  }

  /**
   * A drop warning. At error level when the flush stored nothing and the
   * dropped rows come from more than one project: ClickHouse refusing rows
   * of several projects and storing none may point at the table, not at
   * the rows.
   */
  private warnDrop(run: FlushRun, rows: EnrichedEvent[], message: string, details: object): void {
    const projects = new Set(rows.map((r) => r.project_id)).size;
    if (run.stored === 0 && projects > 1 && this.logger?.error) {
      this.logger.error(message, details);
    } else {
      this.logger?.warn(message, details);
    }
  }

  /** One warning per kind per flush; the cap on rows kept apart. */
  private settle(run: FlushRun): void {
    if (run.dropped.length > 0) {
      const rows = run.dropped.map((d) => d.row);
      this.warnDrop(run, rows, `Dropped ${rows.length} events ClickHouse refused twice`, {
        dropped: rows.length,
        ...summary(rows),
        errors: [...new Set(run.dropped.map((d) => d.error))],
      });
    }
    if (run.unrecognised.length > 0) {
      const rows = run.unrecognised.map((u) => u.row);
      this.logger?.warn(
        `${rows.length} events failed to insert on their own while ClickHouse answers, with an error it does not attribute to their content; kept apart and retried`,
        {
          kept: rows.length,
          ...summary(rows),
          errors: [...new Set(run.unrecognised.map((u) => u.error))],
        },
      );
    }

    const evicted = this.evict();
    if (evicted.length > 0) {
      this.warnDrop(
        run,
        evicted,
        `Dropped ${evicted.length} events kept apart after failed inserts: over the ${this.maxKeptRows}-event limit`,
        { dropped: evicted.length, ...summary(evicted) },
      );
    }
  }

  /**
   * Over `maxKeptRows`: drop rows of the project with the most kept rows,
   * its oldest first, until within the cap — so one project's stream of
   * refused rows does not push out another project's few.
   */
  private evict(): EnrichedEvent[] {
    let over = this.keptCount - this.maxKeptRows;
    if (over <= 0) return [];
    this.kept.sort((a, b) => a.since - b.since);
    const byProjectRows = new Map<string, EnrichedEvent[]>();
    for (const piece of this.kept) {
      for (const row of piece.rows) {
        const list = byProjectRows.get(row.project_id);
        if (list) list.push(row);
        else byProjectRows.set(row.project_id, [row]);
      }
    }
    const evicted = new Set<EnrichedEvent>();
    const taken = new Map<string, number>();
    while (over > 0) {
      let top: string | null = null;
      let topLeft = 0;
      let second = 0;
      for (const [project, list] of byProjectRows) {
        const left = list.length - (taken.get(project) ?? 0);
        if (left > topLeft) {
          second = topLeft;
          topLeft = left;
          top = project;
        } else if (left > second) {
          second = left;
        }
      }
      if (top === null) break;
      const n = Math.min(over, topLeft - second + 1);
      const from = taken.get(top) ?? 0;
      for (const row of (byProjectRows.get(top) ?? []).slice(from, from + n)) evicted.add(row);
      taken.set(top, from + n);
      over -= n;
    }
    this.kept = this.kept
      .map((piece) => {
        const rows = piece.rows.filter((r) => !evicted.has(r));
        return rows.length === piece.rows.length ? piece : { ...piece, rows };
      })
      .filter((piece) => piece.rows.length > 0);
    return [...evicted];
  }

  /**
   * Insert `rows` with up to `attempts` tries; the last error, or undefined
   * once stored. `mapping`: the row mapper threw, before any insert.
   */
  private async insert(
    rows: EnrichedEvent[],
    attempts: number,
  ): Promise<{ error: unknown; mapping?: true } | undefined> {
    let values: ReadonlyArray<Record<string, unknown>>;
    try {
      values = this.mapRow ? rows.map(this.mapRow) : rows;
    } catch (error) {
      return { error, mapping: true };
    }
    const dedupToken = batchToken(rows);
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.clickhouse.insert({
          table: this.table,
          values,
          format: "JSONEachRow",
          clickhouse_settings: { ...INSERT_SETTINGS, insert_deduplication_token: dedupToken },
        });
        return undefined;
      } catch (err) {
        lastError = err;
        // ClickHouse answered with an error that is not about its state:
        // the same rows fail the same way, so there is no point in waiting.
        const code = clickhouseCode(err);
        if (code !== null && !SERVER_ERROR_CODES.has(code) && !RESOURCE_ERROR_CODES.has(code)) {
          break;
        }
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
    // The buffered and retried events, until the deadline: each flush stores
    // its batch, sets aside what ClickHouse refuses, or waits out a failure.
    while (this.bufferedCount > 0 && Date.now() < deadline) {
      const before = this.bufferedCount;
      await this.runFlush();
      if (this.bufferedCount >= before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
      }
    }
    // Then the rows kept apart, as long as a flush settles some of them.
    while (this.keptCount > 0 && Date.now() < deadline) {
      const before = this.keptCount;
      await this.runFlush();
      if (this.keptCount >= before) break;
    }
    if (this.bufferedCount > 0) {
      this.logger?.warn(
        `Shutdown timeout: ${this.bufferedCount} events not written by the deadline, dropped`,
      );
    }
    if (this.keptCount > 0) {
      this.logger?.warn(
        `Shutdown: ${this.keptCount} events kept apart after failed inserts, dropped`,
        summary(this.kept.flatMap((p) => p.rows)),
      );
    }
  }

  /** Events not written yet that count towards backpressure: buffered, or kept after a server error. */
  get bufferedCount(): number {
    return this.buffer.length + this.retryRows;
  }

  /** Rows kept apart while being sorted out; not counted towards backpressure. */
  get keptCount(): number {
    let rows = 0;
    for (const piece of this.kept) rows += piece.rows.length;
    return rows;
  }
}
