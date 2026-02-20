import type { BaseEvent } from "@yavio/shared/events";
import { useEffect } from "react";
import { stripPii } from "../core/pii.js";
import { initAutoCapture } from "./auto-capture.js";
import { resolveWidgetConfig } from "./config.js";
import { SDK_VERSION } from "./constants.js";
import { WidgetTransport } from "./transport.js";
import type { WidgetConfig, YavioWidget } from "./types.js";

/** No-op widget that silently discards all calls. */
const NOOP_WIDGET: YavioWidget = {
  identify() {},
  step() {},
  track() {},
  conversion() {},
};

interface WidgetState {
  widget: YavioWidget;
  cleanup: () => void;
}

/** Module-level singleton — shared across all hook consumers. */
let state: WidgetState | null = null;

/** Cached config — survives React strict-mode remount cycles. */
let cachedConfig: WidgetConfig | null | undefined;

function eventId(): string {
  return crypto.randomUUID();
}

function createState(config: WidgetConfig): WidgetState {
  const transport = new WidgetTransport(config);
  let userId: string | undefined;
  let stepSequence = 0;

  const enqueue = (events: BaseEvent[]) => {
    transport.send(events);
  };

  const cleanupCapture = initAutoCapture(config, enqueue);

  function baseFields(eventType: string, extra?: Record<string, unknown>): BaseEvent {
    return {
      event_id: eventId(),
      event_type: eventType as BaseEvent["event_type"],
      trace_id: config.traceId,
      session_id: config.sessionId,
      timestamp: new Date().toISOString(),
      source: "widget",
      user_id: userId,
      sdk_version: SDK_VERSION,
      ...extra,
    };
  }

  return {
    widget: {
      identify(id: string, traits?: Record<string, unknown>) {
        userId = id;
        enqueue([
          baseFields("identify", {
            user_id: id,
            user_traits: traits ? stripPii(traits) : undefined,
          } as unknown as Record<string, unknown>),
        ]);
      },

      step(name: string, meta?: Record<string, unknown>) {
        stepSequence++;
        enqueue([
          baseFields("step", {
            event_name: name,
            step_sequence: stepSequence,
            metadata: meta ? stripPii(meta) : undefined,
          } as unknown as Record<string, unknown>),
        ]);
      },

      track(event: string, properties?: Record<string, unknown>) {
        enqueue([
          baseFields("track", {
            event_name: event,
            metadata: properties ? stripPii(properties) : undefined,
          } as unknown as Record<string, unknown>),
        ]);
      },

      conversion(
        name: string,
        data: { value: number; currency: string; meta?: Record<string, unknown> },
      ) {
        enqueue([
          baseFields("conversion", {
            event_name: name,
            conversion_value: data.value,
            conversion_currency: data.currency,
            metadata: data.meta ? stripPii(data.meta) : undefined,
          } as unknown as Record<string, unknown>),
        ]);
      },
    },
    cleanup: () => {
      cleanupCapture();
      transport.stop();
    },
  };
}

/**
 * React hook for Yavio widget tracking.
 *
 * Auto-detects configuration injected by the server-side `withYavio()` proxy
 * via `window.__YAVIO__`. Returns a singleton instance shared across all
 * consumers. Cleans up transport and auto-capture listeners on unmount.
 *
 * If no configuration is found, returns a no-op instance that silently
 * discards all events (prevents widget crashes in dev/test).
 */
export function useYavio(config?: Partial<WidgetConfig>): YavioWidget {
  // Resolve and cache config once (survives strict-mode remount)
  if (cachedConfig === undefined) {
    cachedConfig = resolveWidgetConfig(config);
  }

  // Create singleton state if needed
  if (!state) {
    state = cachedConfig ? createState(cachedConfig) : { widget: NOOP_WIDGET, cleanup: () => {} };
  }

  useEffect(() => {
    return () => {
      state?.cleanup();
      state = null;
    };
  }, []);

  return state.widget;
}

/**
 * Reset the singleton (for testing only).
 * @internal
 */
export function _resetWidgetInstance(): void {
  state?.cleanup();
  state = null;
  cachedConfig = undefined;
}
