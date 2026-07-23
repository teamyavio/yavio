import type { Granularity } from "./validation";

/**
 * Format a number with locale-aware separators.
 */
export function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString("en-US");
}

/**
 * Format a decimal as a percentage string.
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format latency in milliseconds to human-readable.
 */
export function formatLatency(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}us`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format currency value. Cents are dropped from 1,000 upwards so large
 * amounts stay short enough for KPI cards.
 */
export function formatCurrency(value: number, currency = "USD"): string {
  const digits = Math.abs(value) >= 1_000 ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format a ClickHouse time bucket ("2026-07-17 00:00:00") as a short
 * axis label appropriate for the granularity, e.g. "Jul 17" or "14:00".
 */
export function formatBucketLabel(bucket: string, granularity: Granularity): string {
  // Week/month buckets arrive date-only ("2026-07-12"), finer ones with time.
  const match = bucket.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return bucket;
  const [, year, month, day, hour, minute] = match;
  const monthName = MONTH_NAMES[Number(month) - 1] ?? month;
  switch (granularity) {
    case "hour":
      return hour ? `${hour}:${minute}` : `${monthName} ${Number(day)}`;
    case "month":
      return `${monthName} ${year}`;
    default:
      return `${monthName} ${Number(day)}`;
  }
}

/**
 * Verbose bucket label for chart tooltips ("Jul 17, 14:00" / "Jul 17, 2026").
 */
export function formatBucketTooltip(bucket: string, granularity: Granularity): string {
  const match = bucket.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return bucket;
  const [, year, month, day, hour, minute] = match;
  const monthName = MONTH_NAMES[Number(month) - 1] ?? month;
  if (granularity === "hour" && hour) return `${monthName} ${Number(day)}, ${hour}:${minute}`;
  if (granularity === "month") return `${monthName} ${year}`;
  if (granularity === "week") return `Week of ${monthName} ${Number(day)}`;
  return `${monthName} ${Number(day)}, ${year}`;
}

/**
 * Format a timestamp as relative time (e.g., "2h ago", "3d ago").
 */
export function formatRelativeTime(timestamp: string | Date): string {
  // ClickHouse returns "YYYY-MM-DD HH:mm:ss.SSS" (no timezone).
  // Append "Z" so JS parses it as UTC instead of local time.
  const raw =
    typeof timestamp === "string" && !timestamp.includes("T") && !timestamp.endsWith("Z")
      ? `${timestamp.replace(" ", "T")}Z`
      : timestamp;
  const date = typeof raw === "string" ? new Date(raw) : raw;
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pick the chart bucket size for a date range so every range renders at a
 * sensible resolution: hourly up to 2 days, daily up to 2 months, weekly
 * up to 6 months, monthly beyond. There is deliberately no user-facing
 * granularity control — the range picker is the single time control.
 */
export function deriveGranularity(from: Date, to: Date): Granularity {
  const rangeMs = to.getTime() - from.getTime();
  if (rangeMs <= 2 * DAY_MS) return "hour";
  if (rangeMs <= 60 * DAY_MS) return "day";
  if (rangeMs <= 184 * DAY_MS) return "week";
  return "month";
}

/**
 * Map granularity to the ClickHouse time-bucket function name.
 */
export function granularityToFunction(granularity: Granularity): string {
  const mapping: Record<Granularity, string> = {
    hour: "toStartOfHour",
    day: "toStartOfDay",
    week: "toStartOfWeek",
    month: "toStartOfMonth",
  };
  return mapping[granularity];
}
