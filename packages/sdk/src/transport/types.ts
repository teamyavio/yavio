import type { BaseEvent } from "@yavio/shared/events";

export interface Transport {
  /** Enqueue events for delivery. */
  send(events: BaseEvent[]): void;
  /** Flush the current buffer immediately. */
  flush(): Promise<void>;
  /**
   * Deliver everything queued so far — every batch, waiting for a flush
   * already in flight — without stopping. Optional: a transport without it
   * is flushed once instead.
   */
  drain?(): Promise<void>;
  /** Stop the timer and flush remaining events. */
  shutdown(): Promise<void>;
}
