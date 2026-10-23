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
   * Such a transport lives within the process budget — each fetch is cut
   * to `fetchBudgetMs()` — so a fetch of its that the budget cuts on its
   * last attempt is the deadline's loss, not a delivery failure (#148
   * review round 2); one that runs into the fetch timeout first is a
   * delivery failure (#151).
   */
  immediate?: boolean;
  /**
   * How long a fetch started now may run, read per attempt and cut to
   * `fetchTimeoutMs`: for a post-signal transport, what is left of the
   * signal cycle, or D after the hand-back (see shared.ts). A timeout fixed
   * when the transport was created — min(30 s, D) — let a send near the
   * deadline run for up to another D past signal + D, its socket keeping a
   * host without `process.exit()` alive past the platform's grace period
   * (#148 review round 3). `now` is the fetch's start, so the budget and the
   * cut the transport records from it agree to the millisecond (#154).
   */
  fetchBudgetMs?: (now: number) => number;
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
  /**
   * Called when a fetch's budget (`fetchBudgetMs`), not the plain fetch
   * timeout, aborts it, with the absolute time the budget ended — for a
   * post-signal transport that is the signal cycle's deadline, or later (the
   * 100 ms floor, D after it). How the registry knows a cycle's deadline
   * came when this timer runs before the cycle's own (#154 review round 3).
   */
  onBudgetCut?: (atMs: number) => void;
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
 * How long a shutdown waits, after its deadline aborted the fetch in
 * flight, for that fetch to settle before its batch is taken for lost. A
 * compliant fetch rejects on abort within a microtask — the loss, or the
 * delivery of a response that had already arrived, is then known and
 * counted where it is (#148 review round 4); only a fetch that ignores its
 * signal runs into this bound.
 */
export const ABORT_SETTLE_MS = 100;

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

/** What a 207 body says: how many of the batch ingest rejected. */
interface PartialBody {
  rejected?: number;
  errors?: unknown[];
}

/**
 * The 207 body, or undefined when it cannot be read — unparsable, or cut by
 * `signal` (the fetch timeout or the shutdown deadline aborting the
 * controller that fetched it): the status said accepted, so neither is a
 * loss, and a `console.debug` note is all it gets. Raced against the signal
 * itself, since a body stream that ignores its abort would otherwise hold
 * the batch in flight past the deadline (#148 review rounds 4 and 6).
 */
async function readPartial(
  response: Response,
  signal: AbortSignal,
): Promise<PartialBody | undefined> {
  try {
    return await new Promise<PartialBody>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => response.json() as Promise<PartialBody>)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  } catch (error) {
    console.debug(
      `[yavio] 207 body unreadable, batch accepted: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
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
   * When the budget (`fetchBudgetMs`) cuts the fetch in flight, absolute;
   * undefined when the fetch timeout bounds it or no fetch is out. What
   * `precountDue()` compares with a signal cycle's deadline (#154).
   */
  private inflightCutAt: number | undefined;
  /**
   * Set while the batch in flight is one a signal cycle's line already
   * counted as not delivered (`precountDue`, #154): it is not pending, and
   * when a deadline gives it up it goes to `precountedLost`, not to
   * `deadlineLost`, so no later line and not the exit hook count it again.
   * Delivered after all, it was counted once, by that line.
   */
  private inflightPrecounted = false;
  /** Events of pre-counted batches that a deadline then gave up. */
  private precountedLost = 0;
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
   * Resolvers of the shutdown's deadline race, so `cutDeadline()` can end
   * it early; and the timer it arms for the earlier deadline (#148 review
   * round 6).
   */
  private readonly shutdownWaiters = new Set<() => void>();
  private cutTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The backoff or `Retry-After` wait in progress, so the shutdown deadline
   * can end it: a sleep that outlasts the deadline would otherwise have its
   * batch counted as lost at the deadline and re-sent when the sleep ends
   * (#148 review round 1).
   */
  private pendingDelay: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  /**
   * Events a shutdown deadline gave up: queued at the deadline, in flight
   * and cut by it, refused after it, or a batch given up because its retry
   * wait would have ended past it. What `YAVIO-1205` counts (#148) — and only that: a batch
   * given up after its last attempt (`YAVIO-1201`) or on an unexpected
   * status is a delivery failure, counted in `failed`, so a failure from
   * hours earlier is not re-reported as a deadline loss at the next signal
   * or exit (#148 review round 2).
   */
  private deadlineLost = 0;
  /** Events given up for a reason other than a deadline: after a batch's last attempt, on an unexpected status, on a 401, or a batch that cannot be serialized. */
  private failed = 0;
  /** Events ingest acknowledged (a 200 or 207): what the registry's loss accounting reads to tell a batch pending at a hand-back that was delivered from one that was lost (#148 review round 5). */
  private delivered = 0;
  /**
   * Set by a 401: nothing is ever sent again. The queue was dropped and
   * counted there, a shutdown drain in progress ends, and a `send()` after
   * it is a counted drop (#148 review round 3).
   */
  private authRejected = false;
  /** `onClosed` runs once: a 401 closes the transport, and a `shutdown()` after it (or the drain the 401 ended) must not report it closed again (#148 review round 5). */
  private closed = false;
  /**
   * Set when the shutdown deadline refused a retry wait (`canWait`): ingest
   * is rate-limiting or failing and the deadline leaves no room for a
   * backoff, so the rest of the queue is given up with the batch — counted
   * once, one line — and the drain ends. Before #148 review round 6 the
   * drain went on to the next batch at once: every remaining batch was
   * fired back-to-back with no backoff and `Retry-After` ignored, 100
   * requests in the last second against a 429 ingest, all of them lost.
   */
  private sendingOver = false;

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
  private readonly fetchBudgetMs: ((now: number) => number) | undefined;
  private readonly onShutdownLoss: ((lost: number, deadlineMs: number) => void) | undefined;
  private readonly onClosed: (() => void) | undefined;
  private readonly onBudgetCut: ((atMs: number) => void) | undefined;
  /** When a fetch's budget last aborted it (`onBudgetCut`), absolute; undefined before that. */
  private lastBudgetCut: number | undefined;

  constructor(options: HttpTransportOptions) {
    this.immediate = options.immediate === true;
    this.fetchBudgetMs = options.fetchBudgetMs;
    this.onShutdownLoss = options.onShutdownLoss;
    this.onClosed = options.onClosed;
    this.onBudgetCut = options.onBudgetCut;
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

  /** Events ingest has not acknowledged: queued, plus the batch in flight unless a line already counted it (`precountDue`). */
  pendingEvents(): number {
    return this.buffer.length + (this.inflightPrecounted ? 0 : this.inflightSize);
  }

  /** Events a shutdown deadline gave up: queued, in flight or refused at or after it, or given up because a retry would have ended past it. What `YAVIO-1205` reports. */
  deadlineLostEvents(): number {
    return this.deadlineLost;
  }

  /** Every event given up so far: what a deadline gave up (pre-counted or not) plus the delivery failures (after a batch's last attempt, or on an unexpected status). */
  lostEvents(): number {
    return this.deadlineLost + this.precountedLost + this.failed;
  }

  /** Every event ingest acknowledged so far. */
  deliveredEvents(): number {
    return this.delivered;
  }

  /** When a fetch's budget last aborted one of this transport's fetches, absolute; undefined if none did. */
  budgetCutAt(): number | undefined {
    return this.lastBudgetCut;
  }

  /** Whether a shutdown deadline cut this transport: its timer fired with the drain unfinished (#154). */
  reachedDeadline(): boolean {
    return this.deadlineReached;
  }

  /**
   * Count the batch in flight as not delivered now, if the budget cuts its
   * fetch by `atMs`: what a signal cycle's line does at its deadline for a
   * post-signal transport's fetch, which that deadline cuts in the same
   * tick but whose outcome is a microtask away (#154). A fetch the budget
   * gives longer (the 100 ms floor of a send just before the deadline) is
   * not due. Returns how many events it counted, 0 when nothing is due or
   * the batch was counted already.
   */
  precountDue(atMs: number): number {
    if (this.inflightPrecounted || this.inflightSize === 0) return 0;
    if (this.inflightCutAt === undefined || this.inflightCutAt > atMs) return 0;
    this.inflightPrecounted = true;
    return this.inflightSize;
  }

  send(events: BaseEvent[]): void {
    if (this.stopped) {
      // A shutdown() still draining, its deadline not reached: the events
      // join the drain and go out with it — a request finishing during a
      // healthy drain is not a deadline loss (#148 review round 2; before,
      // every send after shutdown() began was counted as one).
      const joinsDrain =
        this.closing !== null &&
        !this.drained &&
        !this.deadlineReached &&
        !this.authRejected &&
        !this.sendingOver;
      if (!joinsDrain) {
        // Refused after the deadline: the deadline's loss, counted so it is
        // reported. Stopped for good otherwise — a 401, or the drain is
        // over — and nothing will send them: a delivery failure.
        if (this.deadlineReached || this.sendingOver) this.deadlineLost += events.length;
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
      this.inflightPrecounted = false;
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

  /**
   * Move the deadline of the shutdown in progress to `atMs` (absolute), if
   * that is earlier — never later. A stop that was already running when a
   * signal arrived kept its own, longer deadline: `shutdown(D)` returned
   * the running one, nothing cut its fetch at signal + D, and with D below
   * that stop's value its socket outlived the process deadline and its
   * loss was nobody's but the exit hook's (#148 review round 6). The
   * earlier deadline does what the original does when it fires: the queue
   * is dropped and counted, the fetch in flight aborted, a wait ended.
   * No-op before `shutdown()`, once the drain is done, or after the
   * deadline was reached.
   */
  cutDeadline(atMs: number): void {
    if (!this.closing || this.drained || this.deadlineReached) return;
    if (this.deadlineAt !== undefined && atMs >= this.deadlineAt) return;
    this.deadlineAt = atMs;
    clearTimeout(this.cutTimer);
    this.cutTimer = setTimeout(
      () => {
        this.reachDeadline();
        for (const release of [...this.shutdownWaiters]) release();
      },
      Math.max(0, atMs - Date.now()),
    );
    unref(this.cutTimer);
  }

  /**
   * What the shutdown deadline does when it fires: nothing is sent from
   * now on, the queue is the deadline's loss, the fetch in flight is
   * aborted and a retry wait in progress ended. The batch in flight is not
   * counted here: its outcome is a microtask away — the abort's rejection,
   * or a 200 that had already arrived and whose continuation had not run
   * yet — and is counted where it is known (`giveUp("deadline")` on the
   * abort; nothing on a 200/207). Counting it here reported delivered
   * events as lost (#148 review round 4).
   */
  private reachDeadline(): void {
    this.deadlineReached = true;
    if (this.drained) return;
    this.dropQueue();
    this.inflightController?.abort();
    // A wait in progress ends now: the retry loop wakes, sees the
    // deadline and gives up instead of sending after it.
    this.pendingDelay?.resolve();
  }

  private async runShutdown(deadlineMs: number): Promise<void> {
    this.stopped = true;
    this.deadlineAt = Date.now() + deadlineMs;
    this.stopTimer();

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
      // So does a retry wait the deadline refused: the queue was given up
      // with the batch (`sendingOver`), nothing is fired after it.
      while (this.buffer.length > 0 && !this.authRejected && !this.sendingOver) {
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
    // `cutDeadline()` may end the race earlier through the waiters.
    await raceDeadline(drain(), deadlineMs, {
      onTimeout: () => this.reachDeadline(),
      waiters: this.shutdownWaiters,
    });
    clearTimeout(this.cutTimer);
    if (this.deadlineReached && this.inflight) {
      // The aborted fetch settles at once with a compliant fetch; a fetch
      // that ignores its signal is given this long, then its batch is
      // taken for lost — no deadline waits for it.
      await raceDeadline(this.inflight, ABORT_SETTLE_MS, {
        onTimeout: () => this.giveUp("deadline"),
      });
    }
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
    this.reportClosed();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Tell the registry the transport is settled, once (a 401 and the shutdown after it both end here). */
  private reportClosed(): void {
    if (this.closed) return;
    this.closed = true;
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
      // Read before the try: the catch needs it to tell a cut by the budget
      // from the plain fetch timeout (#151).
      const now = Date.now();
      const budgetMs = this.fetchBudgetMs?.(now);
      try {
        this.inflightController = controller;
        const timeoutMs =
          budgetMs === undefined ? this.fetchTimeoutMs : Math.min(this.fetchTimeoutMs, budgetMs);
        const cutAt =
          budgetMs !== undefined && budgetMs < this.fetchTimeoutMs ? now + budgetMs : undefined;
        this.inflightCutAt = cutAt;
        const timer = setTimeout(() => {
          // The budget's timer, not the fetch timeout's (#151's rule): the
          // deadline it carries has come (#154 review round 3).
          if (cutAt !== undefined) {
            this.lastBudgetCut = cutAt;
            this.onBudgetCut?.(cutAt);
          }
          controller.abort();
        }, timeoutMs);
        unref(timer);
        let response: Response;
        let partial: PartialBody | undefined;
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
          // The 207 body is read here, while the fetch timeout and the
          // shutdown deadline still cover it: read after the controller was
          // let go, a stalled body outran both, the deadline took the
          // accepted batch for lost at ABORT_SETTLE_MS and the body's
          // arrival counted it delivered too (#148 review round 6).
          if (response.status === 207) partial = await readPartial(response, controller.signal);
        } finally {
          clearTimeout(timer);
          this.inflightController = null;
          this.inflightCutAt = undefined;
        }

        if (response.status === 200) {
          this.delivered += batch.length;
          return;
        }

        if (response.status === 207) {
          // Accepted: the status says so, the body only says how many
          // were rejected (read above; unreadable, or cut by the abort, it
          // is still not a loss — before #148 review round 4 a failed read
          // re-sent the accepted batch, and under a deadline counted it as
          // lost).
          if (partial?.rejected) {
            console.warn(
              `[${ErrorCode.SDK.PARTIAL_BATCH_REJECTION}] ${partial.rejected} events rejected`,
            );
          }
          this.delivered += batch.length;
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
          // Dead for good: the flush timer stops ticking into the same
          // 401 every 10 s, and the registry forgets the transport now
          // rather than at the process's end (before #148 review round 5
          // it stayed in the registry's set for the process lifetime).
          this.stopTimer();
          this.reportClosed();
          return;
        }

        if (response.status === 429) {
          if (attempt < this.maxRetries) {
            // Delay-seconds or an HTTP-date; anything else falls back to the backoff.
            const delayMs =
              retryAfterMs(response.headers.get("Retry-After")) ??
              BASE_RETRY_DELAY_MS * 2 ** attempt;
            if (
              !(await this.waitForRetry(
                delayMs,
                `[${ErrorCode.SDK.FLUSH_RATE_LIMITED}] Rate limited, retrying in ${delayMs}ms`,
              ))
            ) {
              return;
            }
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
            if (
              !(await this.waitForRetry(
                BASE_RETRY_DELAY_MS * 2 ** attempt,
                `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Server error ${response.status}, retry ${attempt + 1}/${this.maxRetries}`,
              ))
            ) {
              return;
            }
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
          if (
            !(await this.waitForRetry(
              BASE_RETRY_DELAY_MS * 2 ** attempt,
              `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Network error, retry ${attempt + 1}/${this.maxRetries}`,
            ))
          ) {
            return;
          }
          continue;
        }
        // A fetch the shutdown deadline cut is the deadline's loss, and so
        // is one a post-signal transport's budget cut on its one attempt
        // (that budget is what is left of the process deadline): counted in
        // the YAVIO-1205 line, not reported as a delivery failure as well
        // (#148 review round 7). The budget cut it only if it set the timer,
        // below the fetch timeout. A refused or failed connection is not a
        // cut, nor is a fetch that ran into the plain fetch timeout with
        // more budget left — an explicit `shutdownTimeoutMs` above 30 s:
        // before #151 any abort on a post-signal transport counted as one.
        const cut =
          controller.signal.aborted &&
          (this.deadlineReached ||
            (this.immediate && budgetMs !== undefined && budgetMs < this.fetchTimeoutMs));
        if (!cut) {
          console.error(
            `[${ErrorCode.SDK.FLUSH_FAILED_MAX_RETRIES}] Giving up after ${attempt + 1} attempts`,
          );
        }
        return this.giveUp(cut ? "deadline" : "failed");
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
   * The retry step the 429, 5xx and network branches share: announce the
   * retry and wait `delayMs`, true once the next attempt may go out. False
   * — the batch given up to the deadline — when the deadline forbids the
   * wait or ends it (#148 review round 5, one copy instead of three).
   */
  private async waitForRetry(delayMs: number, message: string): Promise<boolean> {
    if (!this.canWait(delayMs)) {
      // The deadline leaves no room for this wait, so it leaves none for
      // the batches behind this one either: a rate-limited or failing
      // ingest will not take them in time, and firing them back-to-back
      // with no backoff ignores the `Retry-After` it just sent. The whole
      // queue is the deadline's loss, in one count (#148 review round 6).
      this.giveUp("deadline");
      this.dropQueue();
      this.sendingOver = true;
      return false;
    }
    console.warn(message);
    await this.delay(delayMs);
    if (this.deadlineReached) {
      this.giveUp("deadline");
      return false;
    }
    return true;
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
    if (cause === "failed") this.failed += this.inflightSize;
    else if (this.inflightPrecounted) this.precountedLost += this.inflightSize;
    else this.deadlineLost += this.inflightSize;
    this.inflightSize = 0;
  }

  /** Everything queued is the deadline's loss: counted, and the queue emptied so the drain loop ends. */
  private dropQueue(): void {
    this.deadlineLost += this.buffer.length;
    this.buffer.length = 0;
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
