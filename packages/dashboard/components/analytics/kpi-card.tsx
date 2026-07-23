"use client";

import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatLatency, formatNumber, formatPercent } from "@/lib/analytics/format";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";

interface KPICardProps {
  label: string;
  value: number;
  previousValue?: number;
  format: "number" | "percent" | "latency" | "currency";
  currency?: string;
  invertTrend?: boolean;
}

function formatValue(value: number, format: KPICardProps["format"], currency?: string): string {
  switch (format) {
    case "percent":
      return formatPercent(value);
    case "latency":
      return formatLatency(value);
    case "currency":
      return formatCurrency(value, currency);
    default:
      return formatNumber(value);
  }
}

export function KPICard({
  label,
  value,
  previousValue,
  format,
  currency,
  invertTrend,
}: KPICardProps) {
  const formattedValue = formatValue(value, format, currency);

  // No trend without a real previous period: comparing against 0 (or a
  // missing value) would divide by zero and show "Infinity%".
  let trendPercent: number | null = null;
  let trendUp = false;
  const prev = previousValue === undefined ? undefined : Number(previousValue);
  const curr = Number(value);
  if (prev !== undefined && Number.isFinite(prev) && prev !== 0) {
    const pct = ((curr - prev) / prev) * 100;
    if (Number.isFinite(pct)) {
      trendPercent = pct;
      trendUp = pct > 0;
    }
  }

  const trendPositive = invertTrend ? !trendUp : trendUp;

  return (
    <Card>
      <CardContent className="p-4 xl:p-5">
        <p className="truncate text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-2xl font-semibold tracking-tight" title={formattedValue}>
          {formattedValue}
        </p>
        {/* Fixed-height row so cards keep the same size when no trend exists. */}
        <div
          className="mt-1 flex h-4 items-center gap-1 text-xs"
          title={
            trendPercent !== null
              ? `${trendUp ? "Up" : "Down"} ${Math.abs(trendPercent).toFixed(1)}% vs. previous period`
              : undefined
          }
        >
          {trendPercent !== null && (
            <span
              className={cn(
                "flex items-center gap-0.5",
                trendPositive ? "text-green-600" : "text-red-600",
              )}
            >
              {trendUp ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {Math.abs(trendPercent).toFixed(1)}%
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
