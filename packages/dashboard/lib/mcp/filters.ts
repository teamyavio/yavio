import { type Platform, platformValues } from "@yavio/shared/platform";
import { McpToolError } from "./errors";

export interface McpQueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
  platform?: string[];
}

const MAX_LOOKBACK_DAYS = 90; // events TTL — nothing older exists

/** ClickHouse DateTime64 rejects the T/Z of ISO strings. */
function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function parseDate(value: string, name: string): Date {
  const date = new Date(value);
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
 * (default 7 days). Data older than 90 days no longer exists (TTL).
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

/** Silently drops unknown platform names, same as the dashboard filters. */
export function resolvePlatforms(platform?: string[]): string[] | undefined {
  if (!platform || platform.length === 0) return undefined;
  const valid = platform.filter((p): p is Platform =>
    (platformValues as readonly string[]).includes(p),
  );
  return valid.length > 0 ? valid : undefined;
}

export const PLATFORM_VALUES = platformValues;
