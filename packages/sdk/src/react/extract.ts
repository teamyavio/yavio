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
    const sessionSource = widgetSessionSource(candidate.sessionSource);
    return {
      token: candidate.token,
      endpoint: candidate.endpoint,
      traceId: candidate.traceId,
      sessionId: candidate.sessionId,
      ...(sessionSource !== undefined ? { sessionSource } : {}),
    };
  }

  return null;
}

/**
 * The longest `session_source` ingest's schema accepts
 * (`MAX_SESSION_SOURCE_LENGTH` in @yavio/shared, not imported: the widget
 * bundle stays free of the schema module; a test keeps the two equal).
 */
export const WIDGET_MAX_SESSION_SOURCE_LENGTH = 32;

/**
 * A `sessionSource` the widget may stamp (#144): a non-empty string within
 * the schema's bound, else undefined — a longer value would get every widget
 * event rejected. Which values are known is ingest's business (it NULLs the
 * rest).
 */
export function widgetSessionSource(value: unknown): string | undefined {
  return typeof value === "string" &&
    value !== "" &&
    value.length <= WIDGET_MAX_SESSION_SOURCE_LENGTH
    ? value
    : undefined;
}
