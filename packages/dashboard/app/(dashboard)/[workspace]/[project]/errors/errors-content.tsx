"use client";

import {
  CHART_COLORS,
  COMMON_AXIS_PROPS,
  COMMON_CHART_PROPS,
  COMMON_GRID_PROPS,
  SEMANTIC_COLORS,
} from "@/components/analytics/chart-config";
import { ChartPanel } from "@/components/analytics/chart-panel";
import { type Column, DataTable } from "@/components/analytics/data-table";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { EventBadge } from "@/components/analytics/event-badge";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatRelativeTime } from "@/lib/analytics/format";
import type { ErrorCategoryCount, ErrorListItem, TimeSeriesPoint } from "@/lib/queries/types";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
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
  { key: "errorMessage", label: "Message" },
  { key: "platform", label: "Platform" },
];

export function ErrorsContent({ projectId }: { projectId: string }) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const [page, setPage] = useState(1);

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
          <div className="grid grid-cols-2 gap-4">
            <ChartPanel
              title="Error Rate"
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
                    stroke={SEMANTIC_COLORS.error}
                    fill={SEMANTIC_COLORS.error}
                    {...COMMON_CHART_PROPS}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Error Categories">
              <ResponsiveContainer width="100%" height={256}>
                <PieChart>
                  <Pie
                    data={data?.categories ?? []}
                    dataKey="count"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    animationDuration={0}
                  >
                    {(data?.categories ?? []).map((entry, idx) => (
                      <Cell key={entry.category} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
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
