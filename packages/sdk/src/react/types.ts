/** Configuration injected by server-side `withYavio()` proxy. */
export interface WidgetConfig {
  token: string;
  endpoint: string;
  traceId: string;
  sessionId: string;
  /**
   * How the server derived `sessionId` (#144, server SDK 0.5.4 and later):
   * stamped as `session_source` on every widget event, so a widget's rows
   * count for their session the way the server's do — a `per_request`
   * session's widget rows are neither a session nor a person on the read
   * side. Optional: a server before 0.5.4 sends none, and the widget's
   * events then carry none, as before.
   */
  sessionSource?: string;
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
