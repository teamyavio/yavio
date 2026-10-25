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
 * loss, and a note on stderr is all it gets (not stdout, the JSON-RPC wire
 * of a stdio server, #174). Raced against the signal itself, since a body
 * stream that ignores its abort would otherwise hold the batch in flight
 * past the deadline (#148 review rounds 4 and 6).
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
    console.error(
      `[yavio] 207 body unreadable, batch accepted: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * How a `flushQueued()` ended (#171): `done` — everything queued was sent
 * and answered, or the transport stopped (its shutdown reports its own
 * losses); `deadline` — its deadline came with events still queued or in
 * flight; `retrying` — a batch failed and waits for a retry that ends past
 * the deadline, which goes on in the background.
 */
export type FlushOutcome = "done" | "deadline" | "retrying";

/**
 * One batch's send, from its first attempt to its outcome (#171 review
 * round 1). A flush can take the batch back (`abandon()`): a fetch it finds
 * stale, a retry wait whose timer did not run, an early retry. From then on
 * nothing the send does counts or touches the transport's state — its late
 * answer is not counted as delivered, its retry loop ends — and a new send
 * carries the batch, started from the flush that took it back. On
 * Cloudflare Workers a fetch or a timer belongs to the request that started
 * it: once that request has ended, its fetch never settles and its timer
 * never fires, and a promise it created that another request resolves has
 * its continuations cancelled. So no flush waits on, or resolves, what
 * another request's send left behind; it looks at the send's state and
 * starts afresh from its own request.
 */
interface Send {
  batch: BaseEvent[];
  /** The attempt in flight or waited for, from 0. */
  attempt: number;
  /** When that attempt started, absolute: a flush retries early only once it is `BASE_RETRY_DELAY_MS` old (C2). */
  attemptAt: number;
  /** Times a flush took this batch back from a stale fetch (C3): the next fetch may run twice as long first. */
  staleAborts: number;
  /** The first failure of this send prints no retry line: it is a flush's early retry (C2). */
  quiet: boolean;
  /** Set when a flush took the batch back. */
  abandoned: boolean;
  /** When the fetch in flight started, absolute; undefined while none is out. */
  fetchStartedAt?: number;
  /** The controller of that fetch. */
  controller?: AbortController;
}

/** What a batch a flush took back carries to its next send (#171). */
interface Carried {
  batch: BaseEvent[];
  attempt: number;
  staleAborts: number;
  quiet: boolean;
}

export class HttpTransport implements Transport {
  private buffer: BaseEvent[] = [];
  /**
   * A batch a flush took back (#171, decisions C2 and C3), to be sent again
   * before anything else and exactly as it was: the same events in the
   * same order. A resend of rows ingest had stored after all makes the same
   * ClickHouse insert dedup token (event_id and timestamp, migration 0014)
   * only when it makes up a block of its own; otherwise it is collapsed by
   * the ReplacingMergeTree on event_id at merge time.
   */
  private resend: Carried | null = null;
  /** The send in flight, if any (one at a time): what `inflight` is the promise of (#171). */
  private current: Send | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Set by `start()`: the flush interval is armed by the first `send()` after it (#171). */
  private started = false;
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
  private pendingDelay: {
    /** The send that waits. */
    send: Send;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    /** When the wait ends, absolute: a flush watches only a wait that ends before its deadline (#171). */
    endsAt: number;
    /** A `Retry-After` the server sent: a flush waits it out, it never cuts it short (#171). */
    honoured: boolean;
  } | null = null;
  /** Called when a retry wait begins: how a flush watching the batch in flight learns that it failed (#171). */
  private readonly retryWaitWatchers = new Set<() => void>();
  /** How long ingest took to answer the last fetch it answered, in ms; 0 before any answer (#171, C3). */
  private lastRoundTripMs = 0;
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
    // Bound: called as `this._fetch(…)`, an unbound `globalThis.fetch` runs
    // with the transport as `this`. Node does not mind; Cloudflare's workerd
    // throws "Illegal invocation", so every batch failed there as a network
    // error (`YAVIO-1200`) and was dropped after its retries (#171). The
    // widget transport binds it the same way.
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Start the periodic flush. The interval is armed on the first `send()`,
   * not here (#171): Cloudflare Workers forbid timers outside a request, so
   * a `createYavio()` at module scope — which starts the transport — threw
   * "Disallowed operation called within global scope" from `setInterval`
   * and the Worker failed to load. In Node only the interval's phase
   * changes: it counts from the first event instead of from the start.
   */
  start(): void {
    this.started = true;
    if (this.queued() > 0) this.armTimer();
  }

  private armTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    // Don't prevent process exit
    unref(this.timer);
  }

  /** Events ingest has not acknowledged: queued, plus the batch in flight unless a line already counted it (`precountDue`). */
  pendingEvents(): number {
    return this.queued() + (this.inflightPrecounted ? 0 : this.inflightSize);
  }

  /** Events waiting to be sent: the buffer, and a batch waiting to be re-sent (#171). */
  private queued(): number {
    return this.buffer.length + (this.resend?.batch.length ?? 0);
  }

  /** The next batch to send: a batch to re-send first, as it was and with its state, else the head of the buffer. */
  private takeBatch(): Carried {
    const resend = this.resend;
    if (resend) {
      this.resend = null;
      return resend;
    }
    return {
      batch: this.buffer.splice(0, this.maxBatchSize),
      attempt: 0,
      staleAborts: 0,
      quiet: false,
    };
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
    if (this.started && !this.timer) this.armTimer();

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
    if (this.stopped || this.inflight || this.queued() === 0) return;

    // Take the batch synchronously and leave any concurrently-added events.
    await this.startBatch(this.takeBatch(), () => {
      // An immediate transport has no timer to pick up what was queued
      // while this batch was out: send it now.
      if (this.immediate && !this.stopped && this.queued() > 0) {
        this.flush().catch(() => {});
      }
    });
  }

  /**
   * Send one batch as the send in flight; `inflight` and the in-flight size
   * track it until it settles — or until a flush takes it back, after which
   * its settling touches nothing (#171).
   */
  private startBatch(carried: Carried, then?: () => void): Promise<void> {
    const send: Send = {
      batch: carried.batch,
      attempt: carried.attempt,
      attemptAt: Date.now(),
      staleAborts: carried.staleAborts,
      quiet: carried.quiet,
      abandoned: false,
    };
    this.current = send;
    this.inflightSize = send.batch.length;
    const inflight = this.sendBatch(send).finally(() => {
      if (this.current !== send) return;
      this.current = null;
      this.inflight = null;
      this.inflightSize = 0;
      this.inflightPrecounted = false;
      then?.();
    });
    this.inflight = inflight;
    return inflight;
  }

  /**
   * Take the send in flight's batch back, to be sent again first with
   * `next`'s state (#171 review round 1): the send is marked abandoned, the
   * in-flight slot and its wait are cleared without waiting for anything
   * the send created — on Workers its fetch never settles and its timer
   * never fires once its request has ended — and its fetch is aborted, best
   * effort (in Node its send then ends at once; elsewhere the call may do
   * nothing, or throw for another request's object).
   */
  private abandon(send: Send, next: Omit<Carried, "batch">): void {
    send.abandoned = true;
    this.current = null;
    this.inflight = null;
    this.inflightSize = 0;
    this.inflightPrecounted = false;
    if (this.inflightController === send.controller) {
      this.inflightController = null;
      this.inflightCutAt = undefined;
    }
    const wait = this.pendingDelay;
    if (wait && wait.send === send) {
      this.pendingDelay = null;
      try {
        clearTimeout(wait.timer);
      } catch {
        // Another request's timer on Workers: it will not fire anyway.
      }
    }
    try {
      send.controller?.abort();
    } catch {
      // Another request's fetch on Workers: nothing to stop.
    }
    // Defensive: one send at a time, so nothing is waiting to be re-sent here.
    if (this.resend) this.buffer.unshift(...this.resend.batch);
    this.resend = { batch: send.batch, ...next };
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
        if (this.queued() === 0) return;
        try {
          await this.flush();
        } catch {
          // sendBatch has already logged; the next batch still goes out.
        }
      }
    };
    // keepAlive: a drain is a `shutdown()` call's — its retry waits must
    // not let Node exit before it is done or its deadline came (#164).
    await raceDeadline(loop(), deadlineMs, {
      keepAlive: true,
      onTimeout: () => {
        expired = true;
      },
    });
  }

  /**
   * What `client.flush()` does with the transport (#171): send everything
   * queued now, batch after batch, and say how it ended — without stopping
   * anything, and giving up waiting at `deadlineMs` without dropping or
   * aborting anything (decision C1): the fetch in flight goes on, what is
   * queued stays queued. Unlike `drain()` it does not wait through a retry
   * backoff, which on a host that freezes after the response is time the
   * response or the invocation pays for while the instance may never run
   * the retry:
   *
   * - A batch waiting for its retry (a 5xx, a network error, a 429 without
   *   `Retry-After`) is retried at once, once per flush, in a send of the
   *   flush's own; that attempt does not count towards `maxRetries`, and its
   *   failure prints no `YAVIO-1200` line (C2). A `Retry-After` wait is
   *   never cut. A retry wait whose end has passed without its timer
   *   running — on Workers the timer belonged to a request that has ended
   *   — is the retry, sent now and counted. Otherwise a wait is watched
   *   only if it ends before the deadline; past it, the flush returns
   *   `retrying` and the retry stays scheduled.
   * - A fetch in flight for longer than `staleAfterMs` (the flush's own
   *   budget) — doubled for every time its batch was taken back before, at
   *   least twice the last round trip ingest answered in, and capped at the
   *   fetch timeout (`staleAfter`) — that an earlier flush started is
   *   abandoned and its batch re-sent unchanged, first and not counted as
   *   an attempt (C3): an earlier flush
   *   already waited its whole budget on it, after a freeze its connection
   *   is likely dead, and on Workers it never settles once its request has
   *   ended. Without this a hang held the one in-flight slot, and every
   *   later flush, for the 30 s fetch timeout, and on Workers for good. The
   *   doubling and the round trip keep an ingest that answers, only slower
   *   than the budget, delivering: with a fixed bound the head batch was
   *   re-sent forever (#171 review round 1: 1 of 26 tool calls against a
   *   1.5 s ingest; 27 of 27 now). A flush never takes back a send it
   *   started itself, nor one once its own deadline has passed (C1).
   *
   * Every wait of the flush is bounded by a timer of its own (`watch`): it
   * never depends on a promise or timer of another request's send, and it
   * resolves none. A shutdown that takes over is what it then waits for.
   * Concurrent flushes share the batches: each event goes out once.
   */
  async flushQueued(deadlineMs: number, staleAfterMs: number = deadlineMs): Promise<FlushOutcome> {
    const deadlineAt = Date.now() + deadlineMs;
    let expired = false;
    let outcome: FlushOutcome = "done";
    let retried = false; // one early retry per flush (C2)
    const watches = new Set<() => void>();
    // The sends this flush started: it waits for them, it never takes them
    // back — C3 is for what an earlier flush left out, and at its own
    // deadline a flush aborts nothing (C1).
    const own = new Set<Send>();
    const loop = async () => {
      // A batch takes a few rounds here (started, watched, taken back),
      // bounded by the buffer cap like `drain()`.
      const rounds = (Math.ceil(this.maxBufferSize / this.maxBatchSize) + 1) * 4 + 1;
      for (let i = 0; i < rounds && !expired; i++) {
        if (this.closing) {
          await this.closing;
          return;
        }
        if (this.stopped) return;
        const send = this.current;
        if (!send) {
          if (this.queued() === 0) return;
          // Started from this flush, not awaited: the next round watches it.
          this.flush().catch(() => {});
          if (!this.current) return;
          own.add(this.current);
          continue;
        }
        const now = Date.now();
        // Only a send an earlier flush left behind is taken back, and only
        // while this one still has time to send it; never on a post-signal
        // transport, whose every fetch the process deadline bounds (#154).
        const mine =
          !own.has(send) && now < deadlineAt && !this.immediate && !this.inflightPrecounted;
        if (send.fetchStartedAt !== undefined) {
          const staleAt = send.fetchStartedAt + this.staleAfter(send, staleAfterMs);
          if (mine && now > staleAt) {
            const next = { attempt: send.attempt, staleAborts: send.staleAborts + 1, quiet: false };
            this.abandon(send, next);
            continue;
          }
          await this.watch(send, staleAt + 1, watches);
          continue;
        }
        const wait = this.pendingDelay;
        if (wait && wait.send === send) {
          if (mine && now >= wait.endsAt) {
            // Its timer did not run (on Workers it belonged to a request
            // that has ended): the retry, sent now and counted.
            const next = { attempt: send.attempt + 1, staleAborts: send.staleAborts, quiet: false };
            this.abandon(send, next);
            continue;
          }
          const early = !wait.honoured && !retried;
          if (early && now < deadlineAt && !this.immediate) {
            retried = true;
            this.abandon(send, {
              attempt: send.attempt,
              staleAborts: send.staleAborts,
              quiet: true,
            });
            continue;
          }
          if (wait.endsAt >= deadlineAt) {
            outcome = "retrying";
            return;
          }
          await this.watch(send, wait.endsAt, watches);
          continue;
        }
        // Between two steps of its send (a wait just ended, a body read):
        // look again shortly.
        await this.watch(send, now + 10, watches);
      }
    };
    // keepAlive: a host awaits the flush before it returns (#164's rule
    // for a drain): an empty loop must not end the process mid-flush.
    try {
      const work = loop();
      // From the absolute deadline: starting the first fetch takes time.
      await raceDeadline(work, Math.max(0, deadlineAt - Date.now()), {
        keepAlive: true,
        onTimeout: () => {
          expired = true;
        },
      });
    } finally {
      // From this flush's own context, while it is still alive: nothing of
      // another request resolves its promises later.
      for (const end of [...watches]) end();
    }
    return expired ? "deadline" : outcome;
  }

  /**
   * How long a fetch of `send` may be out before a flush takes its batch
   * back (C3): the flush's budget, doubled for every time the batch was
   * taken back before, and at least twice the last round trip ingest
   * answered in — an ingest that answers in 1.5 s keeps its batches —
   * capped at the fetch timeout.
   */
  private staleAfter(send: Send, staleAfterMs: number): number {
    const bound = Math.max(staleAfterMs * 2 ** send.staleAborts, 2 * this.lastRoundTripMs);
    return Math.min(this.fetchTimeoutMs, bound);
  }

  /**
   * Resolves at `at`, or before: once `send` has settled or its next retry
   * wait has begun (#171). The timer is the flush's own, so a send whose
   * request has ended (Workers) cannot hold it; once ended, the watch
   * ignores a late call from anywhere.
   */
  private watch(send: Send, at: number, watches: Set<() => void>): Promise<void> {
    const inflight = this.current === send ? this.inflight : null;
    return new Promise<void>((resolve) => {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        this.retryWaitWatchers.delete(end);
        watches.delete(end);
        resolve();
      };
      const timer = setTimeout(end, Math.max(0, at - Date.now()));
      unref(timer);
      this.retryWaitWatchers.add(end);
      watches.add(end);
      inflight?.then(end, end);
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
      while (this.queued() > 0 && !this.authRejected && !this.sendingOver) {
        await this.startBatch(this.takeBatch()).catch(() => {});
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
    // keepAlive (#164): until the drain is done or its deadline came — the
    // cut one included, whose timer fires because this one holds the loop —
    // the process stays up through the unref'd backoff and `Retry-After`
    // waits; never longer, the timer is cleared with the race.
    await raceDeadline(drain(), deadlineMs, {
      keepAlive: true,
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
      try {
        clearInterval(this.timer);
      } catch {
        // Armed by another request on Workers: it no longer fires.
      }
      this.timer = null;
    }
  }

  /** Tell the registry the transport is settled, once (a 401 and the shutdown after it both end here). */
  private reportClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClosed?.();
  }

  /**
   * Deliver one batch; resolves whatever happens — a batch given up is
   * counted and logged here. Once a flush took the batch back (#171), the
   * send ends at its next step and counts nothing: the resend does.
   */
  private async sendBatch(send: Send): Promise<void> {
    const batch = send.batch;
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

    // Set while the attempt in flight is a flush's early retry (#171): its
    // failure prints no retry line, the flush's `YAVIO-1208` covers it.
    let quiet = send.quiet;
    for (let attempt = send.attempt; attempt <= this.maxRetries; attempt++) {
      if (send.abandoned) return;
      send.attempt = attempt;
      send.attemptAt = Date.now();
      // One controller per fetch, aborted by whichever comes first: the
      // fetch timeout, the shutdown deadline (`runShutdown`), or a flush
      // that takes the batch back (`abandon`). Not `AbortSignal.any`, which
      // needs Node 20.3 while `engines` is `>=20.0.0`.
      const controller = new AbortController();
      send.controller = controller;
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
        send.fetchStartedAt = now;
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
          send.fetchStartedAt = undefined;
          if (this.inflightController === controller) {
            this.inflightController = null;
            this.inflightCutAt = undefined;
          }
        }

        // The answer of a batch a flush took back: the resend counts (#171).
        if (send.abandoned) return;
        this.lastRoundTripMs = Date.now() - now;

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
          const dropped = this.inflightSize + this.queued();
          this.failed += this.queued();
          this.buffer.length = 0;
          this.resend = null;
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
            const retryAfter = retryAfterMs(response.headers.get("Retry-After"));
            const delayMs = retryAfter ?? BASE_RETRY_DELAY_MS * 2 ** attempt;
            const step = await this.waitForRetry(
              send,
              delayMs,
              `[${ErrorCode.SDK.FLUSH_RATE_LIMITED}] Rate limited, retrying in ${delayMs}ms`,
              { quiet, honoured: retryAfter !== undefined },
            );
            if (step === "stop") return;
            quiet = false;
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
            const step = await this.waitForRetry(
              send,
              BASE_RETRY_DELAY_MS * 2 ** attempt,
              `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Server error ${response.status}, retry ${attempt + 1}/${this.maxRetries}`,
              { quiet },
            );
            if (step === "stop") return;
            quiet = false;
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
        // Taken back by a flush (#171): its abort lands here in Node.
        if (send.abandoned) return;
        // Network error (or the abort at the deadline) — retry with backoff
        if (attempt < this.maxRetries) {
          const step = await this.waitForRetry(
            send,
            BASE_RETRY_DELAY_MS * 2 ** attempt,
            `[${ErrorCode.SDK.FLUSH_FAILED_RETRYING}] Network error, retry ${attempt + 1}/${this.maxRetries}`,
            { quiet },
          );
          if (step === "stop") return;
          quiet = false;
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
   * retry (not when `quiet`: a flush's early retry, #171) and wait
   * `delayMs`, then `next` once the next attempt may go out. `stop` — the
   * batch given up to the deadline — when the deadline forbids the wait or
   * ends it (#148 review round 5, one copy instead of three); also when a
   * flush took the batch back meanwhile, whose resend goes on (#171). A
   * `honoured` wait (a `Retry-After`) is never cut by a flush.
   */
  private async waitForRetry(
    send: Send,
    delayMs: number,
    message: string,
    options: { quiet?: boolean; honoured?: boolean } = {},
  ): Promise<"next" | "stop"> {
    if (!this.canWait(delayMs)) {
      // The deadline leaves no room for this wait, so it leaves none for
      // the batches behind this one either: a rate-limited or failing
      // ingest will not take them in time, and firing them back-to-back
      // with no backoff ignores the `Retry-After` it just sent. The whole
      // queue is the deadline's loss, in one count (#148 review round 6).
      this.giveUp("deadline");
      this.dropQueue();
      this.sendingOver = true;
      return "stop";
    }
    if (!options.quiet) console.warn(message);
    await this.delay(send, delayMs, options.honoured === true);
    if (send.abandoned) return "stop";
    if (this.deadlineReached) {
      this.giveUp("deadline");
      return "stop";
    }
    return "next";
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
    this.deadlineLost += this.queued();
    this.buffer.length = 0;
    this.resend = null;
  }

  /**
   * Sleep `ms`, or less: the shutdown deadline ends the wait early through
   * `pendingDelay` (the caller then checks `deadlineReached`). A flush
   * that takes the batch back clears the wait and never ends it (#171): the
   * promise may belong to another request on Workers. One wait at a time —
   * the retry loop is sequential.
   */
  private delay(send: Send, ms: number, honoured = false): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.pendingDelay === wait) this.pendingDelay = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      unref(timer);
      const wait = { send, timer, resolve: done, endsAt: Date.now() + ms, honoured };
      this.pendingDelay = wait;
      // A flush watching the batch in flight learns that it failed (#171).
      for (const watcher of [...this.retryWaitWatchers]) watcher();
    });
  }
}
