"use client";

import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { PageHeader } from "@/components/analytics/page-header";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatNumber, formatPercent } from "@/lib/analytics/format";
import type { FunnelStep } from "@/lib/queries/types";
import { cn } from "@/lib/utils";

interface FunnelData {
  steps: FunnelStep[];
}

export function FunnelsContent({ projectId }: { projectId: string }) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();

  const { data, isLoading, isRefetching, error, retry } = useAnalyticsQuery<FunnelData>({
    url: `/api/analytics/${projectId}/funnels`,
    queryString,
  });

  const maxCount = data?.steps ? Math.max(...data.steps.map((s) => s.count), 1) : 1;

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <PageHeader title="Funnels">
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !isLoading && (!data || data.steps.length === 0) ? (
        <EmptyState
          title="No funnel data"
          description="Funnel data will appear once step and conversion events are tracked with step_sequence values."
        />
      ) : (
        <div className="space-y-2">
          {(data?.steps ?? []).map((step, idx) => {
            const widthPercent = (step.count / maxCount) * 100;
            const isLast = idx === (data?.steps.length ?? 0) - 1;
            return (
              <div key={`${String(step.stepSequence)}-${step.eventName}`}>
                <div className="flex items-center gap-4">
                  <div className="w-8 text-right text-sm font-medium text-muted-foreground">
                    {step.stepSequence}
                  </div>
                  <div className="flex-1">
                    <div
                      className="flex items-center justify-between rounded bg-primary/10 px-3 py-2"
                      style={{ width: `${Math.max(widthPercent, 5)}%` }}
                    >
                      <span className="text-sm font-medium">{step.eventName}</span>
                      <span className="text-sm text-muted-foreground">
                        {formatNumber(step.count)}
                      </span>
                    </div>
                  </div>
                  <div className="w-20 text-right text-xs text-muted-foreground">
                    {step.dropOffPercent > 0 ? formatPercent(1 - step.dropOffPercent) : "100.0%"}
                  </div>
                </div>
                {!isLast && step.dropOffPercent > 0 && (
                  <div className="ml-12 flex items-center gap-2 py-1 text-xs text-muted-foreground">
                    <div className="h-4 border-l border-dashed border-muted-foreground/30" />
                    <span>-{formatPercent(step.dropOffPercent)} drop-off</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
