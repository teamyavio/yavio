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
 * Format currency value.
 */
export function formatCurrency(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
