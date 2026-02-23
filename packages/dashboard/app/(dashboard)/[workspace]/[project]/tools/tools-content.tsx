"use client";

import { type Column, DataTable } from "@/components/analytics/data-table";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatLatency, formatPercent } from "@/lib/analytics/format";
import type { ToolRanking } from "@/lib/queries/types";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

interface ToolListResponse {
  tools: ToolRanking[];
  total: number;
}

const columns: Column<ToolRanking>[] = [
  { key: "toolName", label: "Tool", sortable: true },
  {
    key: "callCount",
    label: "Calls",
    sortable: true,
    align: "right",
    render: (row: ToolRanking) => row.callCount.toLocaleString(),
  },
  {
    key: "successRate",
    label: "Success Rate",
    sortable: true,
    align: "right",
    render: (row: ToolRanking) => formatPercent(row.successRate),
  },
  {
    key: "avgLatencyMs",
    label: "Avg Latency",
    sortable: true,
    align: "right",
    render: (row: ToolRanking) => formatLatency(row.avgLatencyMs),
  },
  {
    key: "errorRate",
    label: "Error Rate",
    sortable: true,
    align: "right",
    render: (row: ToolRanking) => formatPercent(row.errorRate),
  },
];

export function ToolsContent({ projectId }: { projectId: string }) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState("callCount");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const router = useRouter();
  const params = useParams<{ workspace: string; project: string }>();

  const fullQuery = `${queryString}&page=${page}&pageSize=25&sort=${sortKey}&order=${sortOrder}`;

  const { data, isLoading, isRefetching, error, retry } = useAnalyticsQuery<ToolListResponse>({
    url: `/api/analytics/${projectId}/tools`,
    queryString: fullQuery,
  });

  const handleSort = (key: string) => {
    if (key === sortKey) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("desc");
    }
    setPage(1);
  };

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <PageHeader title="Tools">
        <PlatformFilter selected={filters.platform} onChange={(p) => setFilter({ platform: p })} />
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !isLoading && (!data || data.tools.length === 0) ? (
        <EmptyState
          title="No tool calls recorded"
          description="Tool calls will appear here once your MCP server starts processing requests."
        />
      ) : (
        <DataTable
          columns={columns}
          data={data?.tools ?? []}
          sortKey={sortKey}
          sortOrder={sortOrder}
          onSort={handleSort}
          page={page}
          pageSize={25}
          total={data?.total}
          onPageChange={setPage}
          onRowClick={(row) =>
            router.push(
              `/${params.workspace}/${params.project}/tools/${encodeURIComponent(String(row.toolName))}`,
            )
          }
        />
      )}
    </div>
  );
}
