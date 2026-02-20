import type { WidgetConfig } from "./types.js";

declare global {
  interface Window {
    __YAVIO__?: {
      token: string;
      endpoint: string;
      traceId: string;
      sessionId: string;
    };
  }
}

/**
 * Resolve widget config using the following priority:
 *
 * 1. `window.__YAVIO__` — injected by server-side `withYavio()` proxy
 * 2. `<meta name="yavio-config">` — JSON fallback for non-standard setups
 * 3. Explicit options passed to `useYavio()`
 * 4. `null` — no config → no-op mode
 *
 * Deletes `window.__YAVIO__` after reading to reduce XSS exposure window.
 */
export function resolveWidgetConfig(explicit?: Partial<WidgetConfig>): WidgetConfig | null {
  // 1. window.__YAVIO__ (primary)
  if (typeof window !== "undefined" && window.__YAVIO__) {
    const cfg = window.__YAVIO__;
    const config: WidgetConfig = {
      token: cfg.token,
      endpoint: cfg.endpoint,
      traceId: cfg.traceId,
      sessionId: cfg.sessionId,
    };
    // XSS mitigation: remove global after reading
    window.__YAVIO__ = undefined;
    return config;
  }

  // 2. <meta name="yavio-config"> (JSON fallback)
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="yavio-config"]');
    if (meta) {
      try {
        const parsed = JSON.parse(meta.getAttribute("content") ?? "") as WidgetConfig;
        if (parsed.token && parsed.endpoint && parsed.traceId && parsed.sessionId) {
          return parsed;
        }
      } catch {
        // Invalid JSON — fall through
      }
    }
  }

  // 3. Explicit options
  if (explicit?.token && explicit?.endpoint && explicit?.traceId && explicit?.sessionId) {
    return explicit as WidgetConfig;
  }

  // 4. No config — no-op mode
  return null;
}
