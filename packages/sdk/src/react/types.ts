/** Configuration injected by server-side `withYavio()` proxy. */
export interface WidgetConfig {
  token: string;
  endpoint: string;
  traceId: string;
  sessionId: string;
}

/** The tracking API returned by `useYavio()`. */
export interface YavioWidget {
  /** Tie all subsequent widget events to this user. */
  identify(userId: string, traits?: Record<string, unknown>): void;
  /** Record a funnel step. Auto-incrementing `step_sequence` per trace. */
  step(name: string, meta?: Record<string, unknown>): void;
  /** Record a generic custom event. */
  track(event: string, properties?: Record<string, unknown>): void;
  /** Record a revenue attribution event. */
  conversion(
    name: string,
    data: { value: number; currency: string; meta?: Record<string, unknown> },
  ): void;
}
