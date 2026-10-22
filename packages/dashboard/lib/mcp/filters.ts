import { parseUtc } from "@/lib/clickhouse/datetime";
import { type Platform, platformValues } from "@yavio/shared/platform";
import { McpToolError } from "./errors";

export interface McpQueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
  platform?: string[];
}

// Caps the lookback shortcut only, to bound the scan a single call can cause.
// Events are kept 13 months; explicit from/to ranges reach all of it.
const MAX_LOOKBACK_DAYS = 90;

/** ClickHouse DateTime64 rejects the T/Z of ISO strings. */
function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function parseDate(value: string, name: string): Date {
  // Timezone-less inputs are treated as UTC — bare `new Date("...T12:00:00")`
  // would silently parse as server-local while all output is UTC. A date
  // alone is its midnight; the rest is the ClickHouse datetime rule, in
  // one place (`parseUtc`, #148 review round 5).
  const trimmed = value.trim();
  const date = parseUtc(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new McpToolError(
      `${name} is not a valid date. Use ISO format, e.g. 2026-07-01 or 2026-07-01T00:00:00Z.`,
    );
  }
  return date;
}

export interface RangeInput {
  from?: string;
  to?: string;
  lookback_days?: number;
}

/**
 * from/to win when given; otherwise a lookback window ending now
 * (default 7 days, at most MAX_LOOKBACK_DAYS). Events are kept for 13 months.
 */
export function resolveDateRange(input: RangeInput): { from: string; to: string } {
  if (input.from || input.to) {
    const to = input.to ? parseDate(input.to, "to") : new Date();
    const from = input.from
      ? parseDate(input.from, "from")
      : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (from.getTime() >= to.getTime()) {
      throw new McpToolError("from must be before to.");
    }
    return { from: toClickHouseDateTime(from), to: toClickHouseDateTime(to) };
  }

  const days = Math.min(Math.max(input.lookback_days ?? 7, 1), MAX_LOOKBACK_DAYS);
  const now = new Date();
  return {
    from: toClickHouseDateTime(new Date(now.getTime() - days * 24 * 60 * 60 * 1000)),
    to: toClickHouseDateTime(now),
  };
}

/**
 * Unknown platform names are an ERROR here, unlike the dashboard filters
 * which drop them so a bookmarked URL degrades to "no filter". A model has
 * no way to notice that degradation: it would ask for ChatGPT numbers, get
 * project-wide totals, and report them as ChatGPT's. Fail loudly instead,
 * naming the valid values so the caller can retry correctly.
 */
export function resolvePlatforms(platform?: string[]): string[] | undefined {
  if (!platform || platform.length === 0) return undefined;
  const unknown = platform.filter((p) => !(platformValues as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new McpToolError(
      `Unknown platform(s): ${unknown.join(", ")}. Valid values are: ${platformValues.join(", ")}.`,
    );
  }
  return platform as Platform[];
}

/**
 * Echoed in every tool result so the model can see exactly which filters
 * produced the numbers, rather than inferring them from its own request.
 */
export function appliedFilters(ctx: McpQueryContext): {
  from: string;
  to: string;
  platform: string[] | "all";
} {
  return { from: ctx.from, to: ctx.to, platform: ctx.platform ?? "all" };
}
