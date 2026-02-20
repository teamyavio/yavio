import { extractWidgetConfig } from "./extract.js";
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

/** Check if an object has all four required WidgetConfig fields. */
function isCompleteConfig(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.token === "string" &&
    typeof obj.endpoint === "string" &&
    typeof obj.traceId === "string" &&
    typeof obj.sessionId === "string"
  );
}

/**
 * Resolve widget config using the following priority:
 *
 * 1. `window.__YAVIO__` — injected by server-side `withYavio()` proxy
 * 2. `<meta name="yavio-config">` — JSON fallback for non-standard setups
 * 3. `input.yavio` or `input._meta.yavio` — extracted from tool result metadata
 * 4. Explicit `WidgetConfig` fields passed directly
 * 5. `null` — no config → no-op mode
 *
 * Deletes `window.__YAVIO__` after reading to reduce XSS exposure window.
 */
export function resolveWidgetConfig(
  input?: Partial<WidgetConfig> | Record<string, unknown>,
): WidgetConfig | null {
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
        const parsed = JSON.parse(meta.getAttribute("content") ?? "") as Record<string, unknown>;
        if (isCompleteConfig(parsed)) {
          return parsed as unknown as WidgetConfig;
        }
      } catch {
        // Invalid JSON — fall through
      }
    }
  }

  if (input && typeof input === "object") {
    // 3. .yavio / ._meta.yavio — delegate to extractWidgetConfig
    const extracted = extractWidgetConfig(input as Record<string, unknown>);
    if (extracted) return extracted;

    // 4. Explicit WidgetConfig fields
    if (isCompleteConfig(input as Record<string, unknown>)) {
      return input as WidgetConfig;
    }
  }

  // 5. No config — no-op mode
  return null;
}
