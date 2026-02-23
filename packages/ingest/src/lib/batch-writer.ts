import type { ClickHouseClient } from "@clickhouse/client";
import type { EnrichedEvent } from "./event-enricher.js";

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_FLUSH_SIZE = 10_000;
const DEFAULT_MAX_BUFFER_SIZE = 100_000;
const MAX_RETRIES = 3;

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

export class BatchWriter {
  private buffer: EnrichedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clickhouse: ClickHouseClient;
  private readonly table: string;
  private readonly mapRow?: (event: EnrichedEvent) => Record<string, unknown>;
  private readonly flushIntervalMs: number;
  private readonly flushSize: number;
  private readonly maxBufferSize: number;
  private readonly logger?: BatchWriterLogger;
  private flushing = false;

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
    if (this.buffer.length + events.length > this.maxBufferSize) {
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
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;

    this.flushing = true;
    const batch = this.buffer.splice(0, this.flushSize);

    try {
      await this.insertWithRetry(batch);
    } catch {
      // Re-add failed events to front of buffer for next attempt
      this.buffer.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  private async insertWithRetry(batch: EnrichedEvent[]): Promise<void> {
    const values = this.mapRow ? batch.map(this.mapRow) : batch;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.clickhouse.insert({
          table: this.table,
          values,
          format: "JSONEachRow",
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          const delay = 1000 * 2 ** attempt; // 1s, 2s, 4s
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
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
    while (this.buffer.length > 0 && Date.now() < deadline) {
      await this.flush();
    }
    if (this.buffer.length > 0) {
      this.logger?.warn(`Shutdown timeout: ${this.buffer.length} events dropped`);
    }
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }
}
