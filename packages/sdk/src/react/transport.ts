import type { BaseEvent } from "@yavio/shared/events";
import { SDK_VERSION } from "./constants.js";
import type { WidgetConfig } from "./types.js";

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 20;
const MAX_BUFFER_SIZE = 200;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const BEACON_MAX_BYTES = 60_000; // conservative limit below 64KB

export class WidgetTransport {
  private buffer: BaseEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private pendingFlush = false;
  private stopped = false;
  private readonly config: WidgetConfig;
  private readonly _fetch: typeof globalThis.fetch;
  private teardownVisibility: (() => void) | null = null;
  private teardownPagehide: (() => void) | null = null;

  constructor(config: WidgetConfig, fetchFn?: typeof globalThis.fetch) {
    this.config = config;
    this._fetch = fetchFn ?? globalThis.fetch.bind(globalThis);
    this.start();
    this.registerTeardown();
  }

  /** Enqueue events for delivery. */
  send(events: BaseEvent[]): void {
    if (this.stopped) return;

    this.buffer.push(...events);

    // Enforce buffer cap — drop oldest
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      const dropped = this.buffer.length - MAX_BUFFER_SIZE;
      this.buffer.splice(0, dropped);
    }

    // Early flush if batch size reached
    if (this.buffer.length >= MAX_BATCH_SIZE) {
      this.flush().catch(() => {});
    }
  }

  /** Flush the current buffer immediately via fetch. */
  async flush(): Promise<void> {
    if (this.stopped || this.buffer.length === 0) return;

    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }

    this.flushing = true;
    try {
      const batch = this.buffer.splice(0, MAX_BATCH_SIZE);
      await this.sendBatch(batch);
    } finally {
      this.flushing = false;
      if (this.pendingFlush && this.buffer.length > 0 && !this.stopped) {
        this.pendingFlush = false;
        this.flush().catch(() => {});
      }
    }
  }

  /** Stop the transport and remove all listeners. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof document !== "undefined" && this.teardownVisibility) {
      document.removeEventListener("visibilitychange", this.teardownVisibility);
      this.teardownVisibility = null;
    }
    if (typeof window !== "undefined" && this.teardownPagehide) {
      window.removeEventListener("pagehide", this.teardownPagehide);
      this.teardownPagehide = null;
    }
  }

  /** Synchronous beacon flush for page teardown. */
  beaconFlush(): void {
    if (this.buffer.length === 0) return;
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;

    const url = `${this.config.endpoint}?token=${encodeURIComponent(this.config.token)}`;
    const events = [...this.buffer];
    this.buffer.length = 0;
    this.sendBeaconChunked(url, events);
  }

  private sendBeaconChunked(url: string, events: BaseEvent[]): void {
    const body = JSON.stringify({
      events,
      sdk_version: SDK_VERSION,
      sent_at: new Date().toISOString(),
    });

    if (body.length <= BEACON_MAX_BYTES) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }

    // Single event exceeds limit — drop it
    if (events.length <= 1) return;

    // Split in half and try each chunk
    const mid = Math.ceil(events.length / 2);
    this.sendBeaconChunked(url, events.slice(0, mid));
    this.sendBeaconChunked(url, events.slice(mid));
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  }

  private registerTeardown(): void {
    if (typeof document === "undefined") return;

    this.teardownVisibility = () => {
      if (document.visibilityState === "hidden") {
        this.beaconFlush();
      }
    };
    this.teardownPagehide = () => {
      this.beaconFlush();
    };

    document.addEventListener("visibilitychange", this.teardownVisibility);
    window.addEventListener("pagehide", this.teardownPagehide);
  }

  private async sendBatch(batch: BaseEvent[]): Promise<void> {
    const body = JSON.stringify({
      events: batch,
      sdk_version: SDK_VERSION,
      sent_at: new Date().toISOString(),
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this._fetch(this.config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.token}`,
          },
          body,
        });

        // Success
        if (response.status === 200 || response.status === 207) return;

        // Expired/invalid JWT — stop permanently
        if (response.status === 401) {
          this.stopped = true;
          return;
        }

        // Server error — retry with backoff
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          await this.delay(BASE_RETRY_DELAY_MS * 2 ** attempt);
          continue;
        }

        // Rate limited — retry with backoff
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = response.headers.get("Retry-After");
          const delayMs = retryAfter
            ? Number(retryAfter) * 1000
            : BASE_RETRY_DELAY_MS * 2 ** attempt;
          await this.delay(delayMs);
          continue;
        }

        // Other status — give up
        return;
      } catch {
        // Network error — retry with backoff
        if (attempt < MAX_RETRIES) {
          await this.delay(BASE_RETRY_DELAY_MS * 2 ** attempt);
          continue;
        }
        return;
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
