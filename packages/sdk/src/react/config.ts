import { extractWidgetConfig } from "./extract.js";
import type { WidgetConfig } from "./types.js";

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
 * 1. `input.yavio` or `input._meta.yavio` — extracted from tool result metadata
 * 2. Explicit `WidgetConfig` fields passed directly
 * 3. `null` — no config → no-op mode
 */
export function resolveWidgetConfig(
  input?: Partial<WidgetConfig> | Record<string, unknown>,
): WidgetConfig | null {
  if (input && typeof input === "object") {
    // 1. .yavio / ._meta.yavio — delegate to extractWidgetConfig
    const extracted = extractWidgetConfig(input as Record<string, unknown>);
    if (extracted) return extracted;

    // 2. Explicit WidgetConfig fields
    if (isCompleteConfig(input as Record<string, unknown>)) {
      return input as WidgetConfig;
    }
  }

  // 3. No config — no-op mode
  return null;
}
