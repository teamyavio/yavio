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
}
