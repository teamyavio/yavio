/**
 * What each `error_category` value on a tool_call event means, for tooltips.
 *
 * The values are written by the SDK (see packages/shared/src/events.ts). Two
 * of them look alike from the model's side — the MCP SDK delivers a thrown
 * handler error to the client as an `isError` result too — so the distinction
 * between `tool_error` and `unknown` is server-side only and worth spelling
 * out where the value is shown.
 */
const ERROR_CATEGORY_TITLES: Record<string, string> = {
  tool_error: "The handler returned a result with isError: true (a tool-reported failure).",
  unknown: "The handler threw an exception.",
  validation:
    "The call failed before the handler ran: unknown or disabled tool, or arguments the tool's schema rejected. No latency is recorded.",
  server: "The handler returned, but its result failed the tool's own output schema.",
  auth: "Authentication or authorization failed.",
  timeout: "The call timed out.",
  rate_limit: "The call was rate-limited.",
};

/** Tooltip text for a category, or undefined for a value the SDK does not emit. */
export function errorCategoryTitle(category: string | null | undefined): string | undefined {
  return category ? ERROR_CATEGORY_TITLES[category] : undefined;
}
