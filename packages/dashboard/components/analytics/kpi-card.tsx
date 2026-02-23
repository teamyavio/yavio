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

  let trendPercent: number | null = null;
  let trendUp = false;
  if (previousValue !== undefined && previousValue !== 0) {
    trendPercent = ((value - previousValue) / previousValue) * 100;
    trendUp = trendPercent > 0;
  }

  const trendPositive = invertTrend ? !trendUp : trendUp;

  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-3xl font-semibold">{formattedValue}</p>
        {trendPercent !== null && (
          <div
            className={cn(
              "mt-1 flex items-center gap-1 text-xs",
              trendPositive ? "text-green-600" : "text-red-600",
            )}
          >
            {trendUp ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            <span>{Math.abs(trendPercent).toFixed(1)}%</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
