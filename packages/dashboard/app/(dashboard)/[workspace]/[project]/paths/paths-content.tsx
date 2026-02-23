"use client";

import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { PageHeader } from "@/components/analytics/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import type { PathLink } from "@/lib/queries/types";
import dynamic from "next/dynamic";
import { useState } from "react";

const SankeyChart = dynamic(() => import("./sankey-chart"), { ssr: false });

interface PathsData {
  links: PathLink[];
  nodes: string[];
}

export function PathsContent({ projectId }: { projectId: string }) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const ALL = "__all__";
  const [startTool, setStartTool] = useState<string>(ALL);
  const [endTool, setEndTool] = useState<string>(ALL);

  const extraParams = [
    startTool !== ALL ? `startTool=${encodeURIComponent(startTool)}` : "",
    endTool !== ALL ? `endTool=${encodeURIComponent(endTool)}` : "",
  ]
    .filter(Boolean)
    .join("&");

  const fullQuery = extraParams ? `${queryString}&${extraParams}` : queryString;

  const { data, isLoading, isRefetching, error, retry } = useAnalyticsQuery<PathsData>({
    url: `/api/analytics/${projectId}/paths`,
    queryString: fullQuery,
  });

  return (
    <div className={`space-y-6 ${isRefetching ? "opacity-50 transition-opacity" : ""}`}>
      <PageHeader title="Paths">
        <div className="flex items-center gap-2">
          {data && data.nodes.length > 0 && (
            <>
              <Select value={startTool} onValueChange={setStartTool}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="Start tool" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  {data.nodes.map((node) => (
                    <SelectItem key={node} value={node}>
                      {node}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={endTool} onValueChange={setEndTool}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="End tool" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  {data.nodes.map((node) => (
                    <SelectItem key={node} value={node}>
                      {node}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          <DateRangePicker
            from={filters.from}
            to={filters.to}
            onChange={(from, to) => setFilter({ from, to })}
          />
        </div>
      </PageHeader>

      {error ? (
        <ErrorAlert message={error.message} retry={retry} />
      ) : !isLoading && (!data || data.links.length === 0) ? (
        <EmptyState
          title="No path data"
          description="Path data will appear once multiple tool calls occur within sessions."
        />
      ) : (
        <Card>
          <CardContent className="p-4">
            {data && data.links.length > 0 && <SankeyChart links={data.links} nodes={data.nodes} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
