"use client";

import {
  CHART_COLORS,
  COMMON_AXIS_PROPS,
  COMMON_CHART_PROPS,
  COMMON_GRID_PROPS,
} from "@/components/analytics/chart-config";
import { ChartPanel } from "@/components/analytics/chart-panel";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { KPICard } from "@/components/analytics/kpi-card";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import type {
  KPIResult,
  PlatformBreakdown,
  TimeSeriesPoint,
  ToolRanking,
} from "@/lib/queries/types";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
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
          <div className="grid grid-cols-3 gap-4 xl:grid-cols-6">
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

          <div className="grid grid-cols-2 gap-4">
            <ChartPanel
              title="Invocations"
              granularity={filters.granularity}
              onGranularityChange={(g) => setFilter({ granularity: g })}
            >
              <ResponsiveContainer width="100%" height={256}>
                <AreaChart data={data?.timeSeries ?? []}>
                  <CartesianGrid {...COMMON_GRID_PROPS} />
                  <XAxis dataKey="bucket" {...COMMON_AXIS_PROPS} />
                  <YAxis {...COMMON_AXIS_PROPS} />
                  <Tooltip />
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
              <ResponsiveContainer width="100%" height={256}>
                <PieChart>
                  <Pie
                    data={data?.platforms ?? []}
                    dataKey="count"
                    nameKey="platform"
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    animationDuration={0}
                  >
                    {(data?.platforms ?? []).map((entry, idx) => (
                      <Cell key={entry.platform} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ChartPanel title="Top Tools">
              <ResponsiveContainer width="100%" height={256}>
                <BarChart data={data?.topTools ?? []} layout="vertical">
                  <CartesianGrid {...COMMON_GRID_PROPS} />
                  <XAxis type="number" {...COMMON_AXIS_PROPS} />
                  <YAxis dataKey="toolName" type="category" width={120} {...COMMON_AXIS_PROPS} />
                  <Tooltip />
                  <Bar dataKey="callCount" fill={CHART_COLORS[0]} animationDuration={0} />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>
        </>
      )}
    </div>
  );
}
