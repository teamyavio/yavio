import type { WidgetConfig } from "./types.js";

/**
 * Extract Yavio widget config from a tool result or response metadata.
 *
 * Looks for config at `.yavio` (Skybridge responseMetadata) or `._meta.yavio`
 * (raw MCP tool result). Returns a valid `WidgetConfig` if all required fields
 * are present, or `null` otherwise.
 *
 * @example
 * ```tsx
 * const config = extractWidgetConfig(toolResult);
 * if (config) setWidgetConfig(config);
 * ```
 */
export function extractWidgetConfig(
  input: Record<string, unknown> | null | undefined,
): WidgetConfig | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  // Check .yavio (responseMetadata is _meta) or ._meta.yavio (full tool result)
  const yavio =
    (input as Record<string, unknown>).yavio ??
    ((input as Record<string, unknown>)._meta as Record<string, unknown> | undefined)?.yavio;

  if (!yavio || typeof yavio !== "object") {
    return null;
  }

  const candidate = yavio as Record<string, unknown>;
  if (
    typeof candidate.token === "string" &&
    typeof candidate.endpoint === "string" &&
    typeof candidate.traceId === "string" &&
    typeof candidate.sessionId === "string"
  ) {
    return {
      token: candidate.token,
      endpoint: candidate.endpoint,
      traceId: candidate.traceId,
      sessionId: candidate.sessionId,
    };
  }

  return null;
}
