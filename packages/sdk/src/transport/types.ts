import type { BaseEvent } from "@yavio/shared/events";

export interface Transport {
  /** Enqueue events for delivery. */
  send(events: BaseEvent[]): void;
  /** Flush the current buffer immediately. */
  flush(): Promise<void>;
  /**
   * Deliver everything queued so far — every batch, waiting for a flush
   * already in flight — without stopping, giving up at `deadlineMs` (the
   * transport's own `shutdownTimeoutMs` when omitted). Optional: a
   * transport without it is flushed once instead.
   */
  drain?(deadlineMs?: number): Promise<void>;
  /**
   * Stop the timer and flush remaining events, giving up at `deadlineMs`
   * (the transport's own `shutdownTimeoutMs` when omitted).
   */
  shutdown(deadlineMs?: number): Promise<void>;
  /**
   * Move the deadline of a `shutdown()` in progress to the absolute time
   * `atMs`, if that is earlier (never later): what a signal cycle does to a
   * stop that was already running when the signal arrived, so it ends at
   * signal + D with everything else (#148 review round 6). Optional; no-op
   * before `shutdown()` or after its deadline.
   */
  cutDeadline?(atMs: number): void;
}
