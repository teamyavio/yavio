import { formatAbsoluteTime, formatRelativeTime, parseTimestamp } from "@/lib/analytics/format";

interface TimestampProps {
  value: string | Date;
  /**
   * Which rendering is visible. The other one goes into the tooltip, so
   * every timestamp offers both: the exact UTC moment for correlating with
   * logs (#45) and the relative distance for scanning.
   */
  show?: "absolute" | "relative";
  className?: string;
}

/**
 * One timestamp cell for every table and feed: a `<time>` element with the
 * machine-readable instant, the chosen rendering as text and the other in
 * the title.
 */
export function Timestamp({ value, show = "absolute", className }: TimestampProps) {
  const date = parseTimestamp(value);
  const absolute = formatAbsoluteTime(value);
  const relative = formatRelativeTime(value);
  return (
    <time
      dateTime={Number.isNaN(date.getTime()) ? undefined : date.toISOString()}
      title={show === "absolute" ? relative : absolute}
      className={className ?? "whitespace-nowrap"}
    >
      {show === "absolute" ? absolute : relative}
    </time>
  );
}
