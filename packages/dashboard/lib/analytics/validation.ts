import { z } from "zod";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const granularityValues = ["hour", "day", "week", "month"] as const;
export type Granularity = (typeof granularityValues)[number];

import { type Platform, platformValues } from "@yavio/shared/platform";
import { IsoDatetime } from "@yavio/shared/validation";

export { platformValues, type Platform } from "@yavio/shared/platform";

/** Strip trailing "Z" — ClickHouse DateTime64 rejects the timezone suffix. */
const clickHouseDateTime = (iso: string) => iso.replace("T", " ").replace("Z", "");

export const analyticsFiltersSchema = z.object({
  from: IsoDatetime.default(() => new Date(Date.now() - SEVEN_DAYS_MS).toISOString()).transform(
    clickHouseDateTime,
  ),
  to: IsoDatetime.default(() => new Date().toISOString()).transform(clickHouseDateTime),
  // Unrecognised values are dropped rather than rejected — bookmarked URLs
  // may carry platform values from older releases (e.g. "claude-desktop"),
  // and a stale filter should degrade to "no filter", not a 400.
  platform: z
    .string()
    .transform((v) =>
      v.split(",").filter((p): p is Platform => (platformValues as readonly string[]).includes(p)),
    )
    .optional(),
  granularity: z.enum(granularityValues).default("day"),
});

export type AnalyticsFilters = z.infer<typeof analyticsFiltersSchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

/** Longest tool-name filter; the client cuts there too before querying. */
export const TOOL_FILTER_MAX_LENGTH = 200;

/**
 * Extra filters of the invocation list (#44), on top of the analytics
 * filters. `hasIntent` is a flag ("1"/"true"); anything else, including
 * its absence, means "all invocations". The tool name is a free-text
 * filter: a blank value means "no filter" and a pasted overlong value is
 * cut, since neither should blank the page with a 400.
 */
export const invocationFiltersSchema = z.object({
  tool: z
    .string()
    .optional()
    .transform((v) => v?.trim().slice(0, TOOL_FILTER_MAX_LENGTH) || undefined),
  status: z.enum(["success", "error"]).optional(),
  hasIntent: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type InvocationFilters = z.infer<typeof invocationFiltersSchema>;

/**
 * Parse analytics filters + pagination from URLSearchParams.
 */
export function parseAnalyticsParams(searchParams: URLSearchParams) {
  const raw: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    raw[key] = value;
  }

  const filters = analyticsFiltersSchema.safeParse(raw);
  const pagination = paginationSchema.safeParse(raw);

  return { filters, pagination };
}

/**
 * Map granularity to ClickHouse time-bucket function.
 */
export function granularityToClickHouse(granularity: Granularity): string {
  const mapping: Record<Granularity, string> = {
    hour: "toStartOfHour",
    day: "toStartOfDay",
    week: "toStartOfWeek",
    month: "toStartOfMonth",
  };
  return mapping[granularity];
}
