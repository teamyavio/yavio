"use client";

import {
  CHART_COLORS,
  COMMON_AXIS_PROPS,
  COMMON_CHART_PROPS,
  COMMON_GRID_PROPS,
  timeTickInterval,
} from "@/components/analytics/chart-config";
import { ChartPanel } from "@/components/analytics/chart-panel";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { DonutWithLegend } from "@/components/analytics/donut-with-legend";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { KPICard } from "@/components/analytics/kpi-card";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { PLATFORM_META, platformLabel } from "@/components/analytics/platform-meta";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatBucketLabel, formatBucketTooltip, formatNumber } from "@/lib/analytics/format";
import type {
  KPIResult,
  PlatformBreakdown,
  TimeSeriesPoint,
  ToolRanking,
} from "@/lib/queries/types";
import type { Platform } from "@yavio/shared/platform";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface OverviewData {
  kpis: KPIResult[];
  timeSeries: TimeSeriesPoint[];
  platforms: PlatformBreakdown[];
  topTools: ToolRanking[];
}

export function OverviewContent({ projectId }: { projectId: string }) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();

  const { data, isLoading, isRefetching, error, retry } = useAnalyticsQuery<OverviewData>({
    url: `/api/analytics/${projectId}/overview`,
    queryString,
  });

  const hasData = data && (data.kpis.some((k) => k.value > 0) || data.timeSeries.length > 0);

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <PageHeader title="Overview">
        <PlatformFilter selected={filters.platform} onChange={(p) => setFilter({ platform: p })} />
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !isLoading && !hasData ? (
        <EmptyState
          title="No analytics data yet"
          description="Start sending events from your MCP server to see analytics here. Integrate the Yavio SDK to get started."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            {(data?.kpis ?? []).map((kpi) => (
              <KPICard
                key={kpi.label}
                label={kpi.label}
                value={kpi.value}
                previousValue={kpi.previousValue}
                format={kpi.format}
                invertTrend={kpi.label === "Error Rate" || kpi.label === "Avg Latency"}
              />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartPanel title="Invocations">
              <ResponsiveContainer width="100%" height={256}>
                <AreaChart data={data?.timeSeries ?? []} margin={{ right: 20 }}>
                  <CartesianGrid {...COMMON_GRID_PROPS} />
                  <XAxis
                    dataKey="bucket"
                    minTickGap={8}
                    interval={timeTickInterval((data?.timeSeries ?? []).length)}
                    tickFormatter={(v: string) => formatBucketLabel(v, filters.granularity)}
                    {...COMMON_AXIS_PROPS}
                  />
                  <YAxis tickFormatter={(v: number) => formatNumber(v)} {...COMMON_AXIS_PROPS} />
                  <Tooltip
                    labelFormatter={(v) => formatBucketTooltip(String(v), filters.granularity)}
                    formatter={(value?: number) => [(value ?? 0).toLocaleString(), "Invocations"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={CHART_COLORS[0]}
                    fill={CHART_COLORS[0]}
                    {...COMMON_CHART_PROPS}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Platform Breakdown">
              <DonutWithLegend
                data={(data?.platforms ?? []).map((p) => ({
                  key: p.platform,
                  label: platformLabel(p.platform),
                  count: Number(p.count),
                  icon: PLATFORM_META[p.platform as Platform]?.icon,
                }))}
              />
            </ChartPanel>
          </div>

          <ChartPanel title="Top Tools">
            <ResponsiveContainer width="100%" height={256}>
              <BarChart data={data?.topTools ?? []} layout="vertical">
                <CartesianGrid {...COMMON_GRID_PROPS} />
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => formatNumber(v)}
                  {...COMMON_AXIS_PROPS}
                />
                <YAxis
                  dataKey="toolName"
                  type="category"
                  width={160}
                  tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)}
                  {...COMMON_AXIS_PROPS}
                />
                <Tooltip
                  cursor={false}
                  formatter={(value?: number) => [(value ?? 0).toLocaleString(), "Calls"]}
                />
                <Bar dataKey="callCount" fill={CHART_COLORS[0]} animationDuration={0} />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
        </>
      )}
    </div>
  );
}
