import { ErrorCode } from "@yavio/shared/error-codes";
import type { BaseEvent } from "@yavio/shared/events";
import type { Transport } from "./types.js";

export interface HttpTransportOptions {
  endpoint: string;
  apiKey: string;
  sdkVersion: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxBufferSize?: number;
  maxRetries?: number;
  fetchTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const DEFAULT_MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export class HttpTransport implements Transport {
  private buffer: BaseEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private stopped = false;

  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly sdkVersion: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxBufferSize: number;
  private readonly maxRetries: number;
  private readonly fetchTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(options: HttpTransportOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.sdkVersion = options.sdkVersion;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  /** Start the periodic flush timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    // Don't prevent process exit
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  send(events: BaseEvent[]): void {
    if (this.stopped) return;

    this.buffer.push(...events);

    // Enforce buffer cap — drop oldest events
    if (this.buffer.length > this.maxBufferSize) {
      const dropped = this.buffer.length - this.maxBufferSize;
      this.buffer.splice(0, dropped);
      console.warn(`[${ErrorCode.SDK.BUFFER_OVERFLOW}] Dropped ${dropped} oldest events`);
    }

    // Early flush if batch size reached
    if (this.buffer.length >= this.maxBatchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.stopped || this.flushing || this.buffer.length === 0) return;

    this.flushing = true;
    try {
      // Atomic swap: take the batch and leave any concurrently-added events
      const batch = this.buffer.slice(0, this.maxBatchSize);
      this.buffer = this.buffer.slice(this.maxBatchSize);
      await this.sendBatch(batch);
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Race the drain loop against a total shutdown timeout
    let drained = false;
    const drain = async () => {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.maxBatchSize);
        try {
          await this.sendBatch(batch);
        } catch {
          console.warn(
            `[${ErrorCode.SDK.SHUTDOWN_FLUSH_FAILED}] Failed to flush batch on shutdown`,
          );
        }
      }
      drained = true;
    };

    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!drained) {
          console.warn(
            `[${ErrorCode.SDK.SHUTDOWN_FLUSH_FAILED}] Shutdown timeout — events may have been dropped`,
          );
          this.buffer.length = 0;
        }
        resolve();
      }, this.shutdownTimeoutMs);
    });

    await Promise.race([drain(), timeout]);
  }

  private async sendBatch(batch: BaseEvent[]): Promise<void> {
    const body = JSON.stringify({
      events: batch,
      sdk_version: this.sdkVersion,
      sent_at: new Date().toISOString(),
    });

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
        let response: Response;
        try {
          response = await this._fetch(this.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.status === 200) return;

        if (response.status === 207) {
          const data = (await response.json()) as { rejected?: number; errors?: unknown[] };
          if (data.rejected) {
            console.warn(
              `[${ErrorCode.SDK.PARTIAL_BATCH_REJECTION}] ${data.rejected} events rejected`,
            );
          }
          return;
        }

        if (response.status === 401) {
          console.error(
            `[${ErrorCode.SDK.AUTH_REJECTED_PERMANENT}] API key rejected — stopping delivery`,
          );
          this.stopped = true;
          return;
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          // Retry-After header is in seconds per HTTP spec
          const delayMs = retryAfter
            ? Number(retryAfter) * 1000
            : BASE_RETRY_DELAY_MS * 2 ** attempt;
          console.warn(
            `[${ErrorCode.SDK.FLUSH_RATE_LIMITED}] Rate limited, retrying in ${delayMs}ms`,
          );
          await this.delay(delayMs);
          continue;
        }

        // 5xx — retry with backoff
        if (response.status >= 500) {
          if (attempt < this.maxRetries) {
            const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
            console.warn(
              `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Server error ${response.status}, retry ${attempt + 1}/${this.maxRetries}`,
            );
            await this.delay(delayMs);
            continue;
          }
          console.error(
            `[${ErrorCode.SDK.FLUSH_FAILED_MAX_RETRIES}] Giving up after ${this.maxRetries} retries`,
          );
          return;
        }

        // Other unexpected status codes — don't retry
        return;
      } catch (error) {
        // Network error — retry with backoff
        if (attempt < this.maxRetries) {
          const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
          console.warn(
            `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Network error, retry ${attempt + 1}/${this.maxRetries}`,
          );
          await this.delay(delayMs);
          continue;
        }
        console.error(
          `[${ErrorCode.SDK.FLUSH_FAILED_MAX_RETRIES}] Giving up after ${this.maxRetries} retries`,
        );
        return;
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
