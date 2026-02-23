/** A single data point in a time series chart. */
export interface TimeSeriesPoint {
  bucket: string;
  value: number;
}

/** Multiple named series sharing the same time axis. */
export interface MultiSeriesPoint {
  bucket: string;
  [seriesName: string]: string | number;
}

/** KPI card data with optional trend comparison. */
export interface KPIResult {
  label: string;
  value: number;
  previousValue?: number;
  format: "number" | "percent" | "latency" | "currency";
  currency?: string;
}

/** Breakdown by platform or category. */
export interface PlatformBreakdown {
  platform: string;
  count: number;
  percentage: number;
}

/** Tool ranking row. */
export interface ToolRanking {
  toolName: string;
  callCount: number;
  successRate: number;
  avgLatencyMs: number;
  errorRate: number;
}

/** Error list item. */
export interface ErrorListItem {
  eventId: string;
  timestamp: string;
  toolName: string;
  errorCategory: string;
  errorMessage: string;
  platform: string;
}

/** User list row from users_mv. */
export interface UserListItem {
  userId: string;
  firstSeen: string;
  lastSeen: string;
  totalEvents: number;
  totalSessions: number;
  totalToolCalls: number;
  totalConversions: number;
  totalRevenue: number;
  lastPlatform: string;
}

/** Retention cohort data. */
export interface RetentionCohort {
  cohortPeriod: string;
  cohortSize: number;
  retentionByPeriod: number[];
}

/** Funnel step data. */
export interface FunnelStep {
  stepSequence: number;
  eventName: string;
  count: number;
  dropOffPercent: number;
}

/** Sankey link for path visualization. */
export interface PathLink {
  source: string;
  target: string;
  value: number;
}

/** Live event from the feed. */
export interface LiveEvent {
  eventId: string;
  eventType: string;
  eventName: string | null;
  timestamp: string;
  sessionId: string;
  traceId: string;
  userId: string | null;
  platform: string | null;
  status: string | null;
  latencyMs: number | null;
  errorCategory: string | null;
  errorMessage: string | null;
}

/** Latency histogram bucket. */
export interface LatencyBucket {
  rangeLabel: string;
  count: number;
}

/** Error category count. */
export interface ErrorCategoryCount {
  category: string;
  count: number;
  percentage: number;
}

/** Active users (DAU/WAU/MAU) data point. */
export interface ActiveUsersPoint {
  bucket: string;
  dau: number;
  wau: number;
  mau: number;
}

/** Stickiness distribution bucket. */
export interface StickinessBucket {
  activeDays: number;
  userCount: number;
}

/** New vs returning users per time bucket. */
export interface NewVsReturningPoint {
  bucket: string;
  newUsers: number;
  returningUsers: number;
}

/** Latency percentile point for time series. */
export interface LatencyPercentilePoint {
  bucket: string;
  p50: number;
  p95: number;
  p99: number;
}

/** A single tool invocation row. */
export interface ToolInvocation {
  eventId: string;
  timestamp: string;
  traceId: string;
  sessionId: string;
  userId: string | null;
  status: string;
  latencyMs: number | null;
  platform: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  isRetry: number;
  inputValues: string | null;
  outputContent: string | null;
}

/** Tool metadata from tool_registry. */
export interface ToolRegistryEntry {
  toolName: string;
  description: string | null;
  inputSchema: string;
  registeredAt: string;
  updatedAt: string;
}
