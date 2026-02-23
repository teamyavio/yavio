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
import { KPICard } from "@/components/analytics/kpi-card";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatLatency, formatRelativeTime } from "@/lib/analytics/format";
import type {
  ErrorCategoryCount,
  KPIResult,
  LatencyBucket,
  LatencyPercentilePoint,
  PlatformBreakdown,
  TimeSeriesPoint,
  ToolInvocation,
  ToolRegistryEntry,
} from "@/lib/queries/types";
import { Code } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface ToolDetailData {
  registry: ToolRegistryEntry | null;
  kpis: KPIResult[];
  callVolume: TimeSeriesPoint[];
  histogram: LatencyBucket[];
  latencyPercentiles: LatencyPercentilePoint[];
  errorRateTimeSeries: TimeSeriesPoint[];
  errorCategories: ErrorCategoryCount[];
  platforms: PlatformBreakdown[];
  invocations: ToolInvocation[];
  invocationsTotal: number;
}

interface ToolDetailContentProps {
  projectId: string;
  toolName: string;
  workspaceSlug: string;
  projectSlug: string;
}

const invocationColumns: Column<ToolInvocation>[] = [
  {
    key: "timestamp",
    label: "Time",
    render: (row: ToolInvocation) => formatRelativeTime(row.timestamp),
  },
  {
    key: "status",
    label: "Status",
    render: (row: ToolInvocation) => (
      <Badge variant={row.status === "success" ? "default" : "destructive"} className="text-xs">
        {row.status}
      </Badge>
    ),
  },
  {
    key: "latencyMs",
    label: "Latency",
    align: "right",
    render: (row: ToolInvocation) => (row.latencyMs !== null ? formatLatency(row.latencyMs) : "-"),
  },
  { key: "platform", label: "Platform" },
  {
    key: "userId",
    label: "User",
    render: (row: ToolInvocation) => row.userId ?? "-",
  },
  {
    key: "errorCategory",
    label: "Error",
    render: (row: ToolInvocation) => row.errorCategory ?? "-",
  },
  {
    key: "traceId",
    label: "Trace ID",
    render: (row: ToolInvocation) => (
      <span className="font-mono text-xs">{row.traceId.slice(0, 12)}...</span>
    ),
  },
];

export function ToolDetailContent({
  projectId,
  toolName,
  workspaceSlug,
  projectSlug,
}: ToolDetailContentProps) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const [page, setPage] = useState(1);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const handleRowToggle = useCallback((index: number) => {
    setExpandedIndex((prev) => (prev === index ? null : index));
  }, []);

  const fullQuery = `${queryString}&page=${page}&pageSize=25`;

  const { data, isLoading, isRefetching, error, retry } = useAnalyticsQuery<ToolDetailData>({
    url: `/api/analytics/${projectId}/tools/${encodeURIComponent(toolName)}`,
    queryString: fullQuery,
  });

  const hasData = data?.kpis.some((k) => k.value > 0);
  const basePath = `/${workspaceSlug}/${projectSlug}`;

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`${basePath}/tools`}>Tools</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{toolName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={toolName}>
        <PlatformFilter selected={filters.platform} onChange={(p) => setFilter({ platform: p })} />
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      {data?.registry && (
        <div className="flex items-center gap-3">
          {data.registry.description && (
            <p className="text-sm text-muted-foreground">{data.registry.description}</p>
          )}
          {data.registry.inputSchema && data.registry.inputSchema !== "{}" && (
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5 text-xs">
                  <Code className="h-3 w-3" />
                  Input Schema
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Input Schema</DialogTitle>
                  <DialogDescription>{toolName}</DialogDescription>
                </DialogHeader>
                <pre className="max-h-80 overflow-auto rounded bg-muted p-4 text-xs">
                  {tryFormatJson(data.registry.inputSchema)}
                </pre>
              </DialogContent>
            </Dialog>
          )}
        </div>
      )}

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !isLoading && !hasData ? (
        <EmptyState
          title="No data for this tool"
          description="No tool call events have been recorded for this tool in the selected time period."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
              title="Call Volume"
              granularity={filters.granularity}
              onGranularityChange={(g) => setFilter({ granularity: g })}
            >
              <ResponsiveContainer width="100%" height={256}>
                <AreaChart data={data?.callVolume ?? []}>
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

            <ChartPanel title="Latency Distribution">
              <ResponsiveContainer width="100%" height={256}>
                <BarChart data={data?.histogram ?? []}>
                  <CartesianGrid {...COMMON_GRID_PROPS} />
                  <XAxis dataKey="rangeLabel" {...COMMON_AXIS_PROPS} />
                  <YAxis {...COMMON_AXIS_PROPS} />
                  <Tooltip />
                  <Bar dataKey="count" fill={CHART_COLORS[0]} animationDuration={0} />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ChartPanel title="Latency Percentiles">
              <ResponsiveContainer width="100%" height={256}>
                <LineChart data={data?.latencyPercentiles ?? []}>
                  <CartesianGrid {...COMMON_GRID_PROPS} />
                  <XAxis dataKey="bucket" {...COMMON_AXIS_PROPS} />
                  <YAxis {...COMMON_AXIS_PROPS} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="p50"
                    name="P50"
                    stroke={CHART_COLORS[0]}
                    strokeWidth={1.5}
                    dot={false}
                    animationDuration={0}
                  />
                  <Line
                    type="monotone"
                    dataKey="p95"
                    name="P95"
                    stroke={CHART_COLORS[2]}
                    strokeWidth={1.5}
                    dot={false}
                    animationDuration={0}
                  />
                  <Line
                    type="monotone"
                    dataKey="p99"
                    name="P99"
                    stroke={SEMANTIC_COLORS.warning}
                    strokeWidth={1.5}
                    dot={false}
                    animationDuration={0}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel
              title="Error Rate"
              granularity={filters.granularity}
              onGranularityChange={(g) => setFilter({ granularity: g })}
            >
              <ResponsiveContainer width="100%" height={256}>
                <AreaChart data={data?.errorRateTimeSeries ?? []}>
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
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ChartPanel title="Error Categories">
              <ResponsiveContainer width="100%" height={256}>
                <PieChart>
                  <Pie
                    data={data?.errorCategories ?? []}
                    dataKey="count"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    animationDuration={0}
                  >
                    {(data?.errorCategories ?? []).map((entry, idx) => (
                      <Cell key={entry.category} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
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

          <DataTable
            columns={invocationColumns}
            data={data?.invocations ?? []}
            page={page}
            pageSize={25}
            total={data?.invocationsTotal}
            onPageChange={setPage}
            emptyMessage="No invocations in this time range"
            expandedIndex={expandedIndex}
            onRowToggle={handleRowToggle}
            renderExpanded={renderInvocationDetail}
          />
        </>
      )}
    </div>
  );
}

function hasContent(value: string | null): boolean {
  return value !== null && value !== "" && value !== "{}" && value !== "{}";
}

function renderInvocationDetail(row: ToolInvocation) {
  const hasInput = hasContent(row.inputValues);
  const hasOutput = hasContent(row.outputContent);

  if (!hasInput && !hasOutput) {
    return (
      <p className="text-sm text-muted-foreground">
        No input/output data captured for this invocation.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Input
        </h4>
        {hasInput ? (
          <pre className="max-h-60 overflow-auto rounded bg-muted p-3 text-xs">
            {tryFormatJson(row.inputValues as string)}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No input captured</p>
        )}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Output
        </h4>
        {hasOutput ? (
          <pre className="max-h-60 overflow-auto rounded bg-muted p-3 text-xs">
            {tryFormatJson(row.outputContent as string)}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No output captured</p>
        )}
      </div>
    </div>
  );
}

function tryFormatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
