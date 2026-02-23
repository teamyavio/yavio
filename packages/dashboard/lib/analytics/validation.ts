import { z } from "zod";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const granularityValues = ["hour", "day", "week", "month"] as const;
export type Granularity = (typeof granularityValues)[number];

export const platformValues = [
  "claude-desktop",
  "cursor",
  "windsurf",
  "cline",
  "continue",
  "zed",
  "chatgpt",
  "custom",
  "unknown",
] as const;
export type Platform = (typeof platformValues)[number];

/** Strip trailing "Z" — ClickHouse DateTime64 rejects the timezone suffix. */
const clickHouseDateTime = (iso: string) => iso.replace("T", " ").replace("Z", "");

export const analyticsFiltersSchema = z.object({
  from: z
    .string()
    .datetime()
    .default(() => new Date(Date.now() - SEVEN_DAYS_MS).toISOString())
    .transform(clickHouseDateTime),
  to: z
    .string()
    .datetime()
    .default(() => new Date().toISOString())
    .transform(clickHouseDateTime),
  platform: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.enum(platformValues)))
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
