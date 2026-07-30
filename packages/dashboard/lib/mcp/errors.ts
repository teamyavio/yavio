import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";

/** A tool-level failure whose message is meant for the model to read. */
export class McpToolError extends Error {}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function toolText(payload: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
    ],
  };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Uniform error boundary for tool handlers. AnalyticsQueryError carries a
 * user-appropriate message already; never leak .toResponse() (it is a
 * NextResponse, not a tool result).
 */
export async function runTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof McpToolError) {
      return toolError(err.message);
    }
    if (err instanceof AnalyticsQueryError) {
      return toolError(`Analytics query failed (${err.code}): ${err.message}`);
    }
    console.error("[mcp] tool failed:", err);
    return toolError("Internal error while answering this request. Try again.");
  }
}
