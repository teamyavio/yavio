"use client";

import { type Column, DataTable } from "@/components/analytics/data-table";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { errorCategoryTitle } from "@/components/analytics/error-category-meta";
import { EventDetail, InvocationPayloadSections } from "@/components/analytics/event-detail";
import { KPICard } from "@/components/analytics/kpi-card";
import { PageHeader } from "@/components/analytics/page-header";
import { PlatformFilter } from "@/components/analytics/platform-filter";
import { platformLabel } from "@/components/analytics/platform-meta";
import { SkeletonTable } from "@/components/analytics/skeleton-table";
import { Timestamp } from "@/components/analytics/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatCountry, formatLatency } from "@/lib/analytics/format";
import { TOOL_FILTER_MAX_LENGTH } from "@/lib/analytics/validation";
import type { IntentStatus, InvocationFeedItem, InvocationsResponse } from "@/lib/queries/types";
import { cn } from "@/lib/utils";
import { Target } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const PAGE_SIZE = 25;
const TOOL_FILTER_DEBOUNCE_MS = 300;

/**
 * Column classes for the KPI row: Call Coverage is hidden when every call had
 * optional context, and the optional-context share only shows when there are
 * such calls (#73). Full class strings so Tailwind keeps them.
 */
function kpiGridCols(kpis: { coverage: number | null; optionalCoverage: number | null }): string {
  const cards = 2 + (kpis.coverage !== null ? 1 : 0) + (kpis.optionalCoverage !== null ? 1 : 0);
  if (cards === 4) return "sm:grid-cols-2 lg:grid-cols-4";
  if (cards === 3) return "sm:grid-cols-3";
  return "sm:grid-cols-2";
}

/**
 * Why the intent column may be empty, keyed off the SDK's reported
 * intent-capture state so the page never guesses from data absence alone.
 * Null when capture is on and intents are arriving — nothing to explain.
 */
function captureNotice(
  status: IntentStatus | undefined,
  captured: number,
): { title: string; description: string } | null {
  switch (status?.status) {
    case "enabled":
      if (captured > 0) return null;
      return {
        title: "No intents captured in this period",
        description:
          "Intent capture is on, but no tool calls carried a context argument in the selected time range. Some MCP clients do not fill optional or unknown parameters.",
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

interface InvocationsContentProps {
  projectId: string;
  workspaceSlug: string;
  projectSlug: string;
}

/**
 * One time-sorted list of tool calls with the intent inline (#44). The
 * intent-specific KPIs and the capture-status notice of the former Intents
 * page live on top of it, so "how much of this traffic carries an intent"
 * and "what happened this morning" are answered in one place.
 */
export function InvocationsContent({
  projectId,
  workspaceSlug,
  projectSlug,
}: InvocationsContentProps) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const [page, setPage] = useState(1);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [hasIntent, setHasIntent] = useState(false);
  const [status, setStatus] = useState<"" | "success" | "error">("");
  const [toolInput, setToolInput] = useState("");
  const [tool, setTool] = useState("");

  // Typing a tool name must not fire a query per keystroke. A pasted value
  // is cut to what the API accepts so it cannot answer with a 400.
  useEffect(() => {
    const timer = setTimeout(
      () => setTool(toolInput.trim().slice(0, TOOL_FILTER_MAX_LENGTH)),
      TOOL_FILTER_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [toolInput]);

  const listParams = new URLSearchParams();
  if (hasIntent) listParams.set("hasIntent", "1");
  if (status) listParams.set("status", status);
  if (tool) listParams.set("tool", tool);
  const listQuery = listParams.toString();

  // A narrower filter can leave the current page past the end of the new
  // result set — which renders an empty table while the pager hides itself
  // (one page), stranding the user with no way back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets paging when the filters change
  useEffect(() => {
    setPage(1);
    setExpandedIndex(null);
  }, [queryString, listQuery]);

  const fullQuery = `${queryString}&page=${page}&pageSize=${PAGE_SIZE}${listQuery ? `&${listQuery}` : ""}`;

  const { data, isRefetching, error, retry } = useAnalyticsQuery<InvocationsResponse>({
    url: `/api/analytics/${projectId}/invocations`,
    queryString: fullQuery,
  });

  const handleRowToggle = useCallback((index: number) => {
    setExpandedIndex((prev) => (prev === index ? null : index));
  }, []);

  const basePath = `/${workspaceSlug}/${projectSlug}`;

  const columns: Column<InvocationFeedItem>[] = [
    {
      key: "timestamp",
      label: "Time",
      render: (row) => <Timestamp value={row.timestamp} />,
    },
    {
      key: "toolName",
      label: "Tool",
      render: (row) => (
        <Link
          href={`${basePath}/tools/${encodeURIComponent(row.toolName)}`}
          className="whitespace-nowrap font-mono text-xs hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {row.toolName}
        </Link>
      ),
    },
    {
      key: "intent",
      label: "Intent",
      // whitespace-normal overrides the TableCell's nowrap so intent
      // sentences wrap inside the column instead of overflowing it
      render: (row) =>
        row.intent ? (
          <span className="flex min-w-64 max-w-xl items-start gap-2 whitespace-normal">
            {/* Model-written content — plain text only; break-words against
                unbroken tokens (URLs, JSON fragments) */}
            <span className="min-w-0 break-words">{row.intent}</span>
            {row.intentSource === "inferred" && (
              <Badge variant="outline" className="shrink-0 text-xs">
                inferred
              </Badge>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "platform",
      label: "Platform",
      render: (row) => platformLabel(row.platform ?? "unknown"),
    },
    {
      key: "countryCode",
      label: "Country",
      render: (row) =>
        row.countryCode ? (
          <span title={formatCountry(row.countryCode)}>{row.countryCode}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "latencyMs",
      label: "Latency",
      align: "right",
      render: (row) => (row.latencyMs !== null ? formatLatency(row.latencyMs) : "—"),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <Badge
          variant={row.status === "success" ? "default" : "destructive"}
          className="text-xs"
          title={row.errorCategory ? errorCategoryTitle(row.errorCategory) : undefined}
        >
          {row.status}
          {row.errorCategory && <span className="font-normal opacity-80">{row.errorCategory}</span>}
        </Badge>
      ),
    },
    {
      key: "userId",
      label: "User",
      render: (row) =>
        row.userId ? (
          <span className="block max-w-40 truncate font-mono text-xs" title={row.userId}>
            {row.userId}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  const notice = data ? captureNotice(data.intentStatus, data.kpis.captured) : null;
  const filtersActive = hasIntent || status !== "" || tool !== "";
  const nothingAtAll = data !== undefined && data.total === 0 && !filtersActive;

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <PageHeader title="Invocations" onRefresh={retry} refreshing={isRefetching}>
        <PlatformFilter selected={filters.platform} onChange={(p) => setFilter({ platform: p })} />
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !data ? (
        // Counts and capture-status copy are claims about the customer's
        // data — never render them before the first response arrives.
        // Refetches keep showing the previous data (dimmed) instead.
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="h-24 animate-pulse rounded-lg bg-muted" />
            <div className="h-24 animate-pulse rounded-lg bg-muted" />
            <div className="h-24 animate-pulse rounded-lg bg-muted" />
          </div>
          <SkeletonTable rows={10} columns={6} />
        </div>
      ) : nothingAtAll ? (
        <EmptyState
          title="No tool calls in this time range"
          description="Tool calls appear here as your MCP server processes requests. Try a wider date range or another platform."
        />
      ) : (
        <>
          <div className={`grid grid-cols-1 gap-4 ${kpiGridCols(data.kpis)}`}>
            <KPICard label="Intents Captured" value={data.kpis.captured} format="number" />
            {data.kpis.coverage !== null && (
              <KPICard label="Call Coverage" value={data.kpis.coverage} format="percent" />
            )}
            {data.kpis.optionalCoverage !== null && (
              <KPICard
                label="Coverage, Optional Context"
                value={data.kpis.optionalCoverage}
                format="percent"
              />
            )}
            <KPICard
              label="Tools with Intents"
              value={data.kpis.toolsWithIntents}
              format="number"
            />
          </div>

          {notice && (
            <div className="flex items-start gap-3 rounded-md border bg-muted/40 px-4 py-3">
              <Target className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="space-y-0.5 text-sm">
                <p className="font-medium">{notice.title}</p>
                <p className="text-muted-foreground">{notice.description}</p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={toolInput}
              onChange={(e) => setToolInput(e.target.value)}
              placeholder="Filter by tool name"
              aria-label="Filter by tool name"
              maxLength={TOOL_FILTER_MAX_LENGTH}
              className="h-8 w-56 text-xs"
            />
            <Select
              value={status || "all"}
              onValueChange={(v) => setStatus(v === "all" ? "" : (v as "success" | "error"))}
            >
              <SelectTrigger className="h-8 w-32 text-xs" aria-label="Filter by status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={hasIntent ? "default" : "outline"}
              size="sm"
              aria-pressed={hasIntent}
              onClick={() => setHasIntent((v) => !v)}
              className={cn("gap-1.5 text-xs", !hasIntent && "text-muted-foreground")}
            >
              <Target className="h-3 w-3" />
              With intent
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              {data.total.toLocaleString("en-US")} {data.total === 1 ? "invocation" : "invocations"}
            </span>
          </div>

          <DataTable
            columns={columns}
            data={data.invocations}
            page={page}
            pageSize={PAGE_SIZE}
            total={data.total}
            onPageChange={setPage}
            emptyMessage="No invocations match these filters"
            expandedIndex={expandedIndex}
            onRowToggle={handleRowToggle}
            renderExpanded={(row) => (
              <EventDetail
                raw={row}
                fields={[
                  { label: "Event", value: row.eventId, mono: true },
                  { label: "Trace", value: row.traceId, mono: true },
                  { label: "Session", value: row.sessionId, mono: true },
                  { label: "User", value: row.userId, mono: true },
                  {
                    label: "Country",
                    value: row.countryCode ? formatCountry(row.countryCode) : null,
                  },
                  { label: "Error message", value: row.errorMessage, tone: "error" },
                ]}
              >
                <InvocationPayloadSections invocation={row} />
              </EventDetail>
            )}
          />
        </>
      )}
    </div>
  );
}
