import { ErrorCode } from "@yavio/shared/error-codes";
import type { BaseEvent } from "@yavio/shared/events";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../core/config.js";
import { raceDeadline, unref } from "../core/timers.js";
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
  /**
   * Send on every `send()` instead of on the timer: for a transport created
   * after the process began shutting down, when no timer will fire and no
   * shutdown will drain it (see shared.ts). Still batched by the buffer cap.
   * Such a transport lives within the process budget — its fetch timeout is
   * cut to it — so a fetch of its that is aborted on its last attempt is
   * the deadline's loss, not a delivery failure (#148 review round 2).
   */
  immediate?: boolean;
  /**
   * Called once a `shutdown()` whose deadline gave events up has settled,
   * with the count and the deadline (#148). Without it the transport logs
   * its own `YAVIO-1205` line; the registry passes one that lets a signal
   * cycle report every transport's losses in one line.
   */
  onShutdownLoss?: (lost: number, deadlineMs: number) => void;
  /**
   * Called once `shutdown()` has settled — drained, or at its deadline —
   * after `onShutdownLoss`. The registry drops its reference to the
   * transport here, so a host that creates and shuts down a client per
   * request does not keep one transport per request (#148 review round 1).
   */
  onClosed?: () => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const DEFAULT_MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * The longest `Retry-After` wait honoured: the fetch timeout, the longest
 * the transport waits on ingest for anything. A longer value is not worth
 * holding a buffered batch for — the next attempt gets a fresh answer —
 * and must not reach `setTimeout` as is: above 2^31−1 ms Node clamps a
 * timer to 1 ms, which turned one oversized header into a retry storm
 * (#148 review round 1).
 */
export const MAX_RETRY_AFTER_MS = DEFAULT_FETCH_TIMEOUT_MS;

/**
 * A `Retry-After` value as a wait in milliseconds: delay-seconds, or an
 * HTTP-date (counted from now, never negative), either capped at
 * `MAX_RETRY_AFTER_MS`. Undefined when the header is missing or
 * unparsable, so the caller falls back to its backoff — not to
 * `Number("Wed, …") * 1000`, which is NaN and meant an immediate retry
 * (#148).
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Math.min(MAX_RETRY_AFTER_MS, Number(value) * 1000);
  // Every HTTP-date form (IMF-fixdate, RFC 850, asctime) starts with a day
  // name; without that guard `Date.parse` reads "1.5" as a date.
  if (!/^[A-Za-z]{3}/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
}

export class HttpTransport implements Transport {
  private buffer: BaseEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The batch send in flight, if any (one at a time). */
  private inflight: Promise<void> | null = null;
  /**
   * The shutdown in progress or done, once `shutdown()` ran: a second
   * `shutdown()` or a `drain()` after it waits for the same sends instead of
   * resolving at once with a batch still on its way out (#142).
   */
  private closing: Promise<void> | null = null;
  private stopped = false;
  /** Set by `runShutdown` once its drain delivered everything queued: a `send()` after that has nothing to join. */
  private drained = false;
  /** The controller of the fetch in flight: aborted by the fetch timeout or by the shutdown deadline (#148). */
  private inflightController: AbortController | null = null;
  /** Events in the batch in flight, until ingest answered or the batch was given up. */
  private inflightSize = 0;
  /**
   * Absolute time of the shutdown deadline, once `shutdown()` ran: no
   * backoff or `Retry-After` wait that would end at or after it is
   * scheduled, and at the deadline the fetch in flight is aborted — the
   * deadline stops the waiting, not only the awaiting (#148).
   */
  private deadlineAt: number | undefined;
  /** Set by the shutdown deadline timer: nothing is sent from then on. */
  private deadlineReached = false;
  /**
   * The backoff or `Retry-After` wait in progress, so the shutdown deadline
   * can end it: a sleep that outlasts the deadline would otherwise have its
   * batch counted as lost at the deadline and re-sent when the sleep ends
   * (#148 review round 1).
   */
  private pendingDelay: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  /**
   * Events a shutdown deadline gave up: queued or in flight at the deadline,
   * refused after it, or a batch given up because its retry wait would have
   * ended past it. What `YAVIO-1205` counts (#148) — and only that: a batch
   * given up after its last attempt (`YAVIO-1201`) or on an unexpected
   * status is a delivery failure, counted in `failed`, so a failure from
   * hours earlier is not re-reported as a deadline loss at the next signal
   * or exit (#148 review round 2).
   */
  private deadlineLost = 0;
  /** Events given up for a reason other than a deadline: after a batch's last attempt, on an unexpected status, on a 401, or a batch that cannot be serialized. */
  private failed = 0;
  /**
   * Set by a 401: nothing is ever sent again. The queue was dropped and
   * counted there, a shutdown drain in progress ends, and a `send()` after
   * it is a counted drop (#148 review round 3).
   */
  private authRejected = false;

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
  private readonly immediate: boolean;
  private readonly onShutdownLoss: ((lost: number, deadlineMs: number) => void) | undefined;
  private readonly onClosed: (() => void) | undefined;

  constructor(options: HttpTransportOptions) {
    this.immediate = options.immediate === true;
    this.onShutdownLoss = options.onShutdownLoss;
    this.onClosed = options.onClosed;
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
    unref(this.timer);
  }

  /** Events ingest has not acknowledged: queued, plus the batch in flight. */
  pendingEvents(): number {
    return this.buffer.length + this.inflightSize;
  }

  /** Events a shutdown deadline gave up: queued, in flight or refused at or after it, or given up because a retry would have ended past it. What `YAVIO-1205` reports. */
  deadlineLostEvents(): number {
    return this.deadlineLost;
  }

  /** Every event given up so far: what a deadline gave up plus the delivery failures (after a batch's last attempt, or on an unexpected status). */
  lostEvents(): number {
    return this.deadlineLost + this.failed;
  }

  send(events: BaseEvent[]): void {
    if (this.stopped) {
      // A shutdown() still draining, its deadline not reached: the events
      // join the drain and go out with it — a request finishing during a
      // healthy drain is not a deadline loss (#148 review round 2; before,
      // every send after shutdown() began was counted as one).
      const joinsDrain =
        this.closing !== null && !this.drained && !this.deadlineReached && !this.authRejected;
      if (!joinsDrain) {
        // Refused after the deadline: the deadline's loss, counted so it is
        // reported. Stopped for good otherwise — a 401, or the drain is
        // over — and nothing will send them: a delivery failure.
        if (this.deadlineReached) this.deadlineLost += events.length;
        else this.failed += events.length;
        return;
      }
    }

    this.buffer.push(...events);

    // Enforce buffer cap — drop oldest events
    if (this.buffer.length > this.maxBufferSize) {
      const dropped = this.buffer.length - this.maxBufferSize;
      this.buffer.splice(0, dropped);
      console.warn(`[${ErrorCode.SDK.BUFFER_OVERFLOW}] Dropped ${dropped} oldest events`);
    }

    // Early flush if batch size reached — or at once for an immediate
    // transport (events queued during a send go with the next one).
    if (this.immediate || this.buffer.length >= this.maxBatchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.stopped || this.inflight || this.buffer.length === 0) return;

    // Atomic swap: take the batch and leave any concurrently-added events
    const batch = this.buffer.slice(0, this.maxBatchSize);
    this.buffer = this.buffer.slice(this.maxBatchSize);
    await this.startBatch(batch, () => {
      // An immediate transport has no timer to pick up what was queued
      // while this batch was out: send it now.
      if (this.immediate && !this.stopped && this.buffer.length > 0) {
        this.flush().catch(() => {});
      }
    });
  }

  /** Send one batch as the send in flight; `inflight` and the in-flight size track it until it settles. */
  private startBatch(batch: BaseEvent[], then?: () => void): Promise<void> {
    this.inflightSize = batch.length;
    this.inflight = this.sendBatch(batch).finally(() => {
      this.inflight = null;
      this.inflightSize = 0;
      then?.();
    });
    return this.inflight;
  }

  /**
   * Deliver everything queued so far: every batch, after any send already in
   * flight, without stopping the transport. Bounded by the buffer cap, so a
   * producer that keeps queueing cannot make it loop forever, and by
   * `deadlineMs` — the caller's own `shutdownTimeoutMs`, or this transport's
   * when omitted — like `shutdown()`: against a hanging ingest it gives up
   * draining at the deadline, leaves what is queued for the timer flush and
   * does not stop the transport. What a holder's `shutdown()` does while
   * other holders keep the transport (see shared.ts).
   */
  async drain(deadlineMs: number = this.shutdownTimeoutMs): Promise<void> {
    let expired = false;
    const loop = async () => {
      const rounds = Math.ceil(this.maxBufferSize / this.maxBatchSize) + 1;
      for (let i = 0; i < rounds && !expired; i++) {
        // A shutdown took over (a signal, the last holder): its sends are
        // what this drain waits for.
        if (this.closing) {
          await this.closing;
          return;
        }
        if (this.stopped) return;
        if (this.inflight) {
          await this.inflight.catch(() => {});
          continue;
        }
        if (this.buffer.length === 0) return;
        try {
          await this.flush();
        } catch {
          // sendBatch has already logged; the next batch still goes out.
        }
      }
    };
    await raceDeadline(loop(), deadlineMs, {
      onTimeout: () => {
        expired = true;
      },
    });
  }

  /**
   * Stop the timer and deliver everything queued, bounded by `deadlineMs`:
   * the caller's own `shutdownTimeoutMs` (a `createYavio().shutdown()`
   * passes the deadline its client was configured with, cut to the process
   * deadline once a signal fixed one), or this transport's — the value of
   * whoever created it — when omitted; the SDK's signal drain passes what
   * is left of the process budget (#148). At the deadline the fetch in
   * flight is aborted, the queue dropped and the loss counted. Idempotent:
   * every call resolves with the one shutdown that is running, under the
   * deadline of the call that started it, so two holders — or the signal
   * handler and the app's handler — never see "done" with a batch still in
   * flight (#142).
   */
  shutdown(deadlineMs: number = this.shutdownTimeoutMs): Promise<void> {
    if (!this.closing) this.closing = this.runShutdown(deadlineMs);
    return this.closing;
  }

  private async runShutdown(deadlineMs: number): Promise<void> {
    this.stopped = true;
    this.deadlineAt = Date.now() + deadlineMs;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Race the drain loop against a total shutdown timeout. The batch already
    // in flight first: resolving mid-send would let the process exit with a
    // request half-way out. Every send goes through `inflight`, so a drain()
    // that started earlier sees it too. `sendBatch` never rejects: a batch
    // that fails for good is logged there (YAVIO-1201) and the next one
    // still goes out — and should it ever reject, the catch keeps one bad
    // batch from aborting the drain, which would leave `drained` unset, the
    // transport in the registry and `shutdown()` rejecting (#148 review
    // round 3: `JSON.stringify` ran outside the try and a BigInt did that).
    const drain = async () => {
      if (this.inflight) await this.inflight.catch(() => {});
      // A send() during the drain joins the queue and goes out here too. A
      // 401 ends the drain: delivery stopped for good, the queue is dropped.
      while (this.buffer.length > 0 && !this.authRejected) {
        await this.startBatch(this.buffer.splice(0, this.maxBatchSize)).catch(() => {});
      }
      this.drained = true;
    };

    // The timer must not outlive the drain: a host that awaits shutdown()
    // and exits would otherwise stay up for the whole timeout. At the
    // deadline the fetch in flight is aborted and the queue dropped: the
    // deadline ends the sending too, so a host without process.exit() can
    // exit and a hanging ingest cannot keep the process alive (#148).
    const lostBefore = this.deadlineLost;
    await raceDeadline(drain(), deadlineMs, {
      onTimeout: () => {
        this.deadlineReached = true;
        if (this.drained) return;
        this.deadlineLost += this.buffer.length + this.inflightSize;
        this.inflightSize = 0;
        this.buffer.length = 0;
        this.inflightController?.abort();
        // A wait in progress ends now: the retry loop wakes, sees the
        // deadline and gives up instead of sending after it.
        this.pendingDelay?.resolve();
      },
    });
    // Counted here, not in the timer: a batch given up before the deadline
    // (its backoff would have ended after it) is a loss of this shutdown
    // too. A batch that failed for good during the drain (YAVIO-1201) is
    // not: it has its own line, and the deadline did not cause it.
    const lost = this.deadlineLost - lostBefore;
    if (lost > 0) {
      if (this.onShutdownLoss) this.onShutdownLoss(lost, deadlineMs);
      else {
        console.warn(
          `[${ErrorCode.SDK.SHUTDOWN_FLUSH_FAILED}] shutdown() deadline of ${deadlineMs} ms reached — ${lost} events not delivered. Raise shutdownTimeoutMs if the platform's grace period allows.`,
        );
      }
    }
    this.onClosed?.();
  }

  /** Deliver one batch; resolves whatever happens — a batch given up is counted and logged here. */
  private async sendBatch(batch: BaseEvent[]): Promise<void> {
    let body: string;
    try {
      body = JSON.stringify({
        events: batch,
        sdk_version: this.sdkVersion,
        sent_at: new Date().toISOString(),
      });
    } catch (error) {
      // A BigInt or a circular value in an event: nothing to send, a
      // delivery failure with its own line. Before #148 review round 3 this
      // threw out of sendBatch, which rejected the shutdown drain.
      console.error(
        `[${ErrorCode.SDK.FLUSH_FAILED_MAX_RETRIES}] Could not serialize a batch of ${batch.length} events — dropped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.giveUp("failed");
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // One controller per fetch, aborted by whichever comes first: the
      // fetch timeout, or the shutdown deadline (`runShutdown`). Not
      // `AbortSignal.any`, which needs Node 20.3 while `engines` is
      // `>=20.0.0`.
      const controller = new AbortController();
      try {
        this.inflightController = controller;
        const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
        unref(timer);
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
          this.inflightController = null;
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
          // For good: this batch, what is queued and every later send() are
          // delivery failures, counted and announced once here — a shutdown
          // drain no longer sends every remaining batch into the same 401
          // with one line each (#148 review round 3).
          this.authRejected = true;
          this.stopped = true;
          const dropped = this.inflightSize + this.buffer.length;
          this.failed += this.buffer.length;
          this.buffer.length = 0;
          this.giveUp("failed");
          console.error(
            `[${ErrorCode.SDK.AUTH_REJECTED_PERMANENT}] API key rejected — stopping delivery; ${dropped} events dropped`,
          );
          return;
        }

        if (response.status === 429) {
          if (attempt < this.maxRetries) {
            // Delay-seconds or an HTTP-date; anything else falls back to the backoff.
            const delayMs =
              retryAfterMs(response.headers.get("Retry-After")) ??
              BASE_RETRY_DELAY_MS * 2 ** attempt;
            if (!this.canWait(delayMs)) return this.giveUp("deadline");
            console.warn(
              `[${ErrorCode.SDK.FLUSH_RATE_LIMITED}] Rate limited, retrying in ${delayMs}ms`,
            );
            await this.delay(delayMs);
            if (this.deadlineReached) return this.giveUp("deadline");
            continue;
          }
          // The last allowed attempt: the batch is given up like a 5xx on
          // its last attempt — counted and logged, with no wait that nothing
          // would retry after (#148 review round 1).
          console.error(
            `[${ErrorCode.SDK.FLUSH_FAILED_MAX_RETRIES}] Giving up after ${attempt + 1} attempts`,
          );
          return this.giveUp("failed");
        }

        // 5xx — retry with backoff
        if (response.status >= 500) {
          if (attempt < this.maxRetries) {
            const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
            if (!this.canWait(delayMs)) return this.giveUp("deadline");
            console.warn(
              `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Server error ${response.status}, retry ${attempt + 1}/${this.maxRetries}`,
            );
            await this.delay(delayMs);
            if (this.deadlineReached) return this.giveUp("deadline");
            continue;
          }
          console.error(
            `[${ErrorCode.SDK.FLUSH_FAILED_MAX_RETRIES}] Giving up after ${attempt + 1} attempts`,
          );
          return this.giveUp("failed");
        }

        // Other unexpected status codes — don't retry
        return this.giveUp("failed");
      } catch (error) {
        // Network error (or the abort at the deadline) — retry with backoff
        if (attempt < this.maxRetries) {
          const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
          if (!this.canWait(delayMs)) return this.giveUp("deadline");
          console.warn(
            `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Network error, retry ${attempt + 1}/${this.maxRetries}`,
          );
          await this.delay(delayMs);
          if (this.deadlineReached) return this.giveUp("deadline");
          continue;
        }
        console.error(
          `[${ErrorCode.SDK.FLUSH_FAILED_MAX_RETRIES}] Giving up after ${attempt + 1} attempts`,
        );
        // A post-signal transport's fetch timeout is the process budget: a
        // fetch it cut on the transport's one attempt is the deadline's
        // loss. A refused or failed connection is not.
        return this.giveUp(this.immediate && controller.signal.aborted ? "deadline" : "failed");
      }
    }
  }

  /**
   * Whether a wait of `ms` still ends before the shutdown deadline. A wait
   * that would end at or after it is not scheduled: the batch is given up
   * instead of being re-sent after the process was meant to be gone (#148).
   */
  private canWait(ms: number): boolean {
    if (this.deadlineReached) return false;
    return this.deadlineAt === undefined || Date.now() + ms < this.deadlineAt;
  }

  /**
   * The batch in flight is given up, counted once (zero if the deadline
   * timer already did) under its cause: the shutdown deadline — a retry
   * wait that would end past it, or the deadline itself ending a wait — so
   * an exit or a signal cycle can report what the deadline cost; or a
   * delivery failure — the last attempt (`YAVIO-1201`), an unexpected
   * status, a 401, a batch that cannot be serialized — which has its own
   * line and is not a deadline's loss.
   */
  private giveUp(cause: "deadline" | "failed"): void {
    if (cause === "deadline") this.deadlineLost += this.inflightSize;
    else this.failed += this.inflightSize;
    this.inflightSize = 0;
  }

  /**
   * Sleep `ms`, or less: the shutdown deadline ends the wait early through
   * `pendingDelay` (the caller then checks `deadlineReached`). One wait at
   * a time — the retry loop is sequential.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pendingDelay = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      unref(timer);
      this.pendingDelay = { timer, resolve: done };
    });
  }
}
