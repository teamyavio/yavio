"use client";

import {
  COMMON_AXIS_PROPS,
  COMMON_CHART_PROPS,
  COMMON_GRID_PROPS,
  SEMANTIC_COLORS,
  timeTickInterval,
} from "@/components/analytics/chart-config";
import { ChartPanel } from "@/components/analytics/chart-panel";
import { type Column, DataTable } from "@/components/analytics/data-table";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { DonutWithLegend } from "@/components/analytics/donut-with-legend";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { platformLabel } from "@/components/analytics/platform-meta";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import {
  formatBucketLabel,
  formatBucketTooltip,
  formatPercent,
  formatRelativeTime,
} from "@/lib/analytics/format";
import type { ErrorCategoryCount, ErrorListItem, TimeSeriesPoint } from "@/lib/queries/types";
import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface ErrorsData {
  timeSeries: TimeSeriesPoint[];
  categories: ErrorCategoryCount[];
  errors: ErrorListItem[];
  total: number;
}

const columns: Column<ErrorListItem>[] = [
  {
    key: "timestamp",
    label: "Time",
    render: (row: ErrorListItem) => formatRelativeTime(row.timestamp),
  },
  { key: "toolName", label: "Tool" },
  { key: "errorCategory", label: "Category" },
  {
    key: "errorMessage",
    label: "Message",
    render: (row: ErrorListItem) => (
      <span className="block max-w-xl truncate" title={row.errorMessage ?? undefined}>
        {row.errorMessage}
      </span>
    ),
  },
  {
    key: "platform",
    label: "Platform",
    render: (row: ErrorListItem) => platformLabel(row.platform ?? "unknown"),
  },
];

export function ErrorsContent({ projectId }: { projectId: string }) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const [page, setPage] = useState(1);

  // A narrower range or platform can leave the current page past the end of
  // the new result set, stranding the user on an empty table with the pager
  // hidden. Same fix as the Intents page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets paging when the filters change
  useEffect(() => {
    setPage(1);
  }, [queryString]);

  const fullQuery = `${queryString}&page=${page}&pageSize=25`;

  const { data, isLoading, isRefetching, error, retry } = useAnalyticsQuery<ErrorsData>({
    url: `/api/analytics/${projectId}/errors`,
    queryString: fullQuery,
  });

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <PageHeader title="Errors">
        <PlatformFilter selected={filters.platform} onChange={(p) => setFilter({ platform: p })} />
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !isLoading && (!data || data.total === 0) ? (
        <EmptyState
          title="No errors recorded"
          description="No tool call errors have been recorded in this time period."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartPanel title="Error Rate">
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
                  <YAxis
                    tickFormatter={(v: number) => formatPercent(v, 0)}
                    {...COMMON_AXIS_PROPS}
                  />
                  <Tooltip
                    labelFormatter={(v) => formatBucketTooltip(String(v), filters.granularity)}
                    formatter={(value?: number) => [formatPercent(value ?? 0), "Error rate"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={SEMANTIC_COLORS.error}
                    fill={SEMANTIC_COLORS.error}
                    {...COMMON_CHART_PROPS}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Error Categories">
              <DonutWithLegend
                data={(data?.categories ?? []).map((c) => ({
                  key: c.category,
                  label: c.category,
                  count: Number(c.count),
                }))}
              />
            </ChartPanel>
          </div>

          <DataTable
            columns={columns}
            data={data?.errors ?? []}
            page={page}
            pageSize={25}
            total={data?.total}
            onPageChange={setPage}
            emptyMessage="No errors in this time range"
          />
        </>
      )}
    </div>
  );
}
