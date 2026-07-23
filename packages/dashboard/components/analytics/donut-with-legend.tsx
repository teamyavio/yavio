"use client";

import { CHART_COLORS } from "@/components/analytics/chart-config";
import { formatPercent } from "@/lib/analytics/format";
import type { ComponentType, SVGProps } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

export interface DonutDatum {
  key: string;
  label: string;
  count: number;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
}

interface DonutWithLegendProps {
  data: DonutDatum[];
  /** Slices beyond this are aggregated into "Other" so the monochrome
   *  palette never repeats and stays unambiguous. */
  maxSlices?: number;
}

export function DonutWithLegend({ data, maxSlices = 5 }: DonutWithLegendProps) {
  const sorted = [...data]
    .map((d) => ({ ...d, count: Number(d.count) }))
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count);
  const total = sorted.reduce((sum, d) => sum + d.count, 0);

  let slices = sorted;
  if (sorted.length > maxSlices) {
    const rest = sorted.slice(maxSlices);
    slices = [
      ...sorted.slice(0, maxSlices),
      {
        key: "__other",
        label: `Other (${rest.length})`,
        count: rest.reduce((sum, d) => sum + d.count, 0),
      },
    ];
  }

  if (total === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No data available
      </div>
    );
  }

  return (
    <div className="flex min-h-64 flex-wrap items-center gap-x-6 gap-y-4">
      <div className="h-52 w-52 flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="count"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={58}
              outerRadius={96}
              animationDuration={0}
            >
              {slices.map((entry, idx) => (
                <Cell key={entry.key} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value?: number, name?: string) => [
                `${(value ?? 0).toLocaleString()} (${formatPercent((value ?? 0) / total)})`,
                name,
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="min-w-48 flex-1 space-y-2">
        {slices.map((entry, idx) => {
          const Icon = entry.icon;
          return (
            <li key={entry.key} className="flex items-center gap-2 text-sm">
              <span
                className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }}
              />
              {Icon && <Icon className="h-4 w-4 flex-shrink-0 text-foreground" />}
              <span className="truncate">{entry.label}</span>
              <span className="ml-auto pl-2 text-muted-foreground tabular-nums">
                {entry.count.toLocaleString()}
              </span>
              <span className="w-12 text-right font-medium tabular-nums">
                {formatPercent(entry.count / total, 0)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
