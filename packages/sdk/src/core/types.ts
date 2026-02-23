/** Resolved SDK configuration after discovery. */
export interface YavioConfig {
  apiKey: string;
  endpoint: string;
  capture: CaptureConfig;
}

/** Controls which auto-captured data is included. */
export interface CaptureConfig {
  inputValues: boolean;
  outputValues: boolean;
  geo: boolean;
  tokens: boolean;
  retries: boolean;
}

/** Options passed to `withYavio()`. */
export interface WithYavioOptions {
  apiKey?: string;
  endpoint?: string;
  capture?: Partial<CaptureConfig>;
}

/** The tracking context injected as `ctx.yavio` in tool handlers. */
export interface YavioContext {
  identify(userId: string, traits?: Record<string, unknown>): void;
  step(name: string, meta?: Record<string, unknown>): void;
  track(event: string, properties?: Record<string, unknown>): void;
  conversion(
    name: string,
    data: { value: number; currency: string; meta?: Record<string, unknown> },
  ): void;
}

/** Session state stored per MCP connection. */
export interface SessionState {
  sessionId: string;
  userId: string | null;
  userTraits: Record<string, unknown>;
  platform: string;
  stepSequence: number;
}
