import type { BaseEvent } from "@yavio/shared/events";

export interface Transport {
  /** Enqueue events for delivery. */
  send(events: BaseEvent[]): void;
  /** Flush the current buffer immediately. */
  flush(): Promise<void>;
  /** Stop the timer and flush remaining events. */
  shutdown(): Promise<void>;
}
