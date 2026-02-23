"use client";

import {
  CHART_COLORS,
  COMMON_AXIS_PROPS,
  COMMON_CHART_PROPS,
  COMMON_GRID_PROPS,
} from "@/components/analytics/chart-config";
import { ChartPanel } from "@/components/analytics/chart-panel";
import { type Column, DataTable } from "@/components/analytics/data-table";
import { DateRangePicker } from "@/components/analytics/date-range-picker";
import { EmptyState } from "@/components/analytics/empty-state";
import { ErrorAlert } from "@/components/analytics/error-alert";
import { PageHeader } from "@/components/analytics/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAnalyticsFilters } from "@/hooks/use-analytics-filters";
import { useAnalyticsQuery } from "@/hooks/use-analytics-query";
import { formatNumber, formatRelativeTime } from "@/lib/analytics/format";
import type { ActiveUsersPoint, NewVsReturningPoint, UserListItem } from "@/lib/queries/types";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface UserListResponse {
  users: UserListItem[];
  total: number;
}

interface ActiveUsersResponse {
  activeUsers: ActiveUsersPoint[];
  newVsReturning: NewVsReturningPoint[];
}

const userColumns: Column<UserListItem>[] = [
  { key: "userId", label: "User ID", sortable: true },
  {
    key: "firstSeen",
    label: "First Seen",
    sortable: true,
    render: (row: UserListItem) => formatRelativeTime(row.firstSeen),
  },
  {
    key: "lastSeen",
    label: "Last Seen",
    sortable: true,
    render: (row: UserListItem) => formatRelativeTime(row.lastSeen),
  },
  {
    key: "totalSessions",
    label: "Sessions",
    sortable: true,
    align: "right",
    render: (row: UserListItem) => formatNumber(row.totalSessions),
  },
  {
    key: "totalToolCalls",
    label: "Tool Calls",
    sortable: true,
    align: "right",
    render: (row: UserListItem) => formatNumber(row.totalToolCalls),
  },
  {
    key: "totalConversions",
    label: "Conversions",
    sortable: true,
    align: "right",
    render: (row: UserListItem) => formatNumber(row.totalConversions),
  },
];

export function UsersContent({ projectId }: { projectId: string }) {
  const { filters, setFilter, queryString } = useAnalyticsFilters();
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState("lastSeen");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const listQuery = `${queryString}&page=${page}&pageSize=25&sort=${sortKey}&order=${sortOrder}`;

  const {
    data: listData,
    isLoading,
    isRefetching,
    error: listError,
    retry: listRetry,
  } = useAnalyticsQuery<UserListResponse>({
    url: `/api/analytics/${projectId}/users`,
    queryString: listQuery,
  });

  const {
    data: activeData,
    error: activeError,
    retry: activeRetry,
  } = useAnalyticsQuery<ActiveUsersResponse>({
    url: `/api/analytics/${projectId}/users/active`,
    queryString,
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
      <PageHeader title="Users">
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => setFilter({ from, to })}
        />
      </PageHeader>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">User List</TabsTrigger>
          <TabsTrigger value="active">Active Users</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          {listError ? (
            <ErrorAlert message={listError.message} retry={listRetry} />
          ) : !isLoading && (!listData || listData.users.length === 0) ? (
            <EmptyState
              title="No identified users"
              description="Users will appear here once .identify() is called in your MCP server."
            />
          ) : (
            <DataTable
              columns={userColumns}
              data={listData?.users ?? []}
              sortKey={sortKey}
              sortOrder={sortOrder}
              onSort={handleSort}
              page={page}
              pageSize={25}
              total={listData?.total}
              onPageChange={setPage}
            />
          )}
        </TabsContent>

        <TabsContent value="active" className="mt-4 space-y-4">
          {activeError ? (
            <ErrorAlert message={activeError.message} retry={activeRetry} />
          ) : (
            <>
              <ChartPanel
                title="DAU / WAU / MAU"
                granularity={filters.granularity}
                onGranularityChange={(g) => setFilter({ granularity: g })}
              >
                <ResponsiveContainer width="100%" height={256}>
                  <LineChart data={activeData?.activeUsers ?? []}>
                    <CartesianGrid {...COMMON_GRID_PROPS} />
                    <XAxis dataKey="bucket" {...COMMON_AXIS_PROPS} />
                    <YAxis {...COMMON_AXIS_PROPS} />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="dau"
                      name="DAU"
                      stroke={CHART_COLORS[0]}
                      {...COMMON_CHART_PROPS}
                    />
                    <Line
                      type="monotone"
                      dataKey="wau"
                      name="WAU"
                      stroke={CHART_COLORS[2]}
                      {...COMMON_CHART_PROPS}
                    />
                    <Line
                      type="monotone"
                      dataKey="mau"
                      name="MAU"
                      stroke={CHART_COLORS[4]}
                      {...COMMON_CHART_PROPS}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel title="New vs Returning Users">
                <ResponsiveContainer width="100%" height={256}>
                  <AreaChart data={activeData?.newVsReturning ?? []}>
                    <CartesianGrid {...COMMON_GRID_PROPS} />
                    <XAxis dataKey="bucket" {...COMMON_AXIS_PROPS} />
                    <YAxis {...COMMON_AXIS_PROPS} />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="newUsers"
                      name="New"
                      stackId="1"
                      stroke={CHART_COLORS[0]}
                      fill={CHART_COLORS[0]}
                      {...COMMON_CHART_PROPS}
                    />
                    <Area
                      type="monotone"
                      dataKey="returningUsers"
                      name="Returning"
                      stackId="1"
                      stroke={CHART_COLORS[3]}
                      fill={CHART_COLORS[3]}
                      {...COMMON_CHART_PROPS}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
