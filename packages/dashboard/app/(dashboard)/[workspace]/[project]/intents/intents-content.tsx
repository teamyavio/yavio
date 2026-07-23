"use client";

import { type Column, DataTable } from "@/components/analytics/data-table";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { KPICard } from "@/components/analytics/kpi-card";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { platformLabel } from "@/components/analytics/platform-meta";
import { Badge } from "@/components/ui/badge";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatRelativeTime } from "@/lib/analytics/format";
import type { IntentFeedItem, IntentKPIs, IntentStatus } from "@/lib/queries/types";
import Link from "next/link";
import { useState } from "react";

interface IntentsData {
  intents: IntentFeedItem[];
  total: number;
  kpis: IntentKPIs;
  intentStatus: IntentStatus;
}

interface IntentsContentProps {
  projectId: string;
  workspaceSlug: string;
  projectSlug: string;
}

/**
 * Full-page empty state, keyed off the SDK's reported intent-capture state so
 * the page never guesses from data absence alone.
 */
function pageEmptyCopy(status: IntentStatus | undefined): {
  title: string;
  description: string;
} {
  switch (status?.status) {
    case "enabled":
      return {
        title: "No intents captured in this period",
        description:
          "Intent capture is on, but no tool calls carried a context argument in the selected time range. Try a wider date range — and note that some MCP clients do not fill optional or unknown parameters.",
      };
    case "disabled":
      return {
        title: "See why agents call your tools",
        description:
          "Intent capture is off. Enable it with one line — withYavio(server, { intent: true }) — and every tool call arrives with the calling model's one-sentence explanation of the user's goal.",
      };
    case "unsupported":
      return {
        title: "Intent capture requires SDK 0.2.0 or later",
        description: `This project last connected with ${status.sdkVersion ? `SDK ${status.sdkVersion}` : "an older SDK version"}. Update @yavio/sdk and enable intent capture with intent: true.`,
      };
    default:
      return {
        title: "No SDK connection recorded yet",
        description:
          "Once your server serves its first tool call on @yavio/sdk 0.2.0 or later, intent capture status and captured intents appear here.",
      };
  }
}

export function IntentsContent({ projectId, workspaceSlug, projectSlug }: IntentsContentProps) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const [page, setPage] = useState(1);

  const fullQuery = `${queryString}&page=${page}&pageSize=25`;

  const { data, isLoading, isRefetching, error, retry } = useAnalyticsQuery<IntentsData>({
    url: `/api/analytics/${projectId}/intents`,
    queryString: fullQuery,
  });

  const basePath = `/${workspaceSlug}/${projectSlug}`;

  const columns: Column<IntentFeedItem>[] = [
    {
      key: "timestamp",
      label: "Time",
      render: (row: IntentFeedItem) => (
        <span className="whitespace-nowrap">{formatRelativeTime(row.timestamp)}</span>
      ),
    },
    {
      key: "intent",
      label: "Intent",
      // whitespace-normal overrides the TableCell's nowrap so intent
      // sentences wrap inside the column instead of overflowing it
      render: (row: IntentFeedItem) => (
        <span className="flex max-w-xl items-start gap-2 whitespace-normal">
          {/* Model-written content — plain text only; break-words against
              unbroken tokens (URLs, JSON fragments) */}
          <span className="min-w-0 break-words">{row.intent}</span>
          {row.source === "inferred" && (
            <Badge variant="outline" className="shrink-0 text-xs">
              inferred
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "toolName",
      label: "Tool",
      render: (row: IntentFeedItem) => (
        <Link
          href={`${basePath}/tools/${encodeURIComponent(row.toolName)}`}
          className="whitespace-nowrap font-mono text-xs hover:underline"
        >
          {row.toolName}
        </Link>
      ),
    },
    {
      key: "platform",
      label: "Platform",
      render: (row: IntentFeedItem) => platformLabel(row.platform ?? "unknown"),
    },
    {
      key: "status",
      label: "Status",
      render: (row: IntentFeedItem) => (
        <Badge variant={row.status === "success" ? "default" : "destructive"} className="text-xs">
          {row.status}
        </Badge>
      ),
    },
  ];

  const empty = pageEmptyCopy(data?.intentStatus);
  const hasIntents = (data?.total ?? 0) > 0;

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <PageHeader title="Intents">
        <PlatformFilter selected={filters.platform} onChange={(p) => setFilter({ platform: p })} />
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !isLoading && data && !hasIntents ? (
        <EmptyState title={empty.title} description={empty.description} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KPICard label="Intents Captured" value={data?.kpis.captured ?? 0} format="number" />
            <KPICard label="Call Coverage" value={data?.kpis.coverage ?? 0} format="percent" />
            <KPICard
              label="Tools with Intents"
              value={data?.kpis.toolsWithIntents ?? 0}
              format="number"
            />
          </div>

          <DataTable
            columns={columns}
            data={data?.intents ?? []}
            page={page}
            pageSize={25}
            total={data?.total}
            onPageChange={setPage}
            emptyMessage="No intents in this time range"
          />
        </>
      )}
    </div>
  );
}
