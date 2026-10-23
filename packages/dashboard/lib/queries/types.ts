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
  /**
   * A short note under the value on what it leaves out, e.g. the Sessions
   * KPI's "N calls from clients without a session key" (#144). Unset when
   * there is nothing to say.
   */
  hint?: string;
}

/** Breakdown by platform or category. */
export interface PlatformBreakdown {
  platform: string;
  count: number;
  percentage: number;
}

/** Tool calls and users of one bucket in the Locations breakdown (#129). */
export interface LocationTotals {
  toolCalls: number;
  /** Counted for the bucket itself (Users page key), not summed from smaller buckets. */
  users: number;
}

/** One region of a country in the Locations breakdown (#129). `region` null = Unknown. */
export interface LocationRegion extends LocationTotals {
  region: string | null;
}

/**
 * One country in the Locations breakdown (#129). `users` is counted for the
 * country itself, not summed from its regions — a person seen in two regions
 * is one user of the country.
 */
export interface LocationCountry extends LocationTotals {
  countryCode: string;
  /** Known regions by tool calls, the Unknown region last. */
  regions: LocationRegion[];
}

/** Locations card (#129): tool calls by country and region, plus how many had a location. */
export interface LocationBreakdown {
  totalToolCalls: number;
  /** Tool calls with a country. */
  locatedToolCalls: number;
  /** Countries by tool calls. */
  countries: LocationCountry[];
  /**
   * Tool calls without a country, or null when every call had one. Only
   * ChatGPT sends a location, and only to apps that capture arguments.
   */
  unknown: LocationTotals | null;
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

/** User list row, computed from events (#89). userId is the user key: user_id, else subject_id. */
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
/** One row of the project-wide intents feed. */
export interface IntentFeedItem {
  eventId: string;
  timestamp: string;
  intent: string;
  source: string;
  toolName: string;
  platform: string;
  status: string;
  sessionId: string;
}

/** Headline numbers for the intents page. */
export interface IntentKPIs {
  captured: number;
  /**
   * Share of required-context calls (and calls from SDKs before 0.4.0) in the
   * period that carried an intent (0..1). Null when every call had optional
   * context, so there is nothing to measure it on.
   */
  coverage: number | null;
  /**
   * Share of optional-context calls (widget-invoked tools, or intent
   * `required: false`) that carried an intent (0..1); null without such calls.
   * The widget's own calls are in the denominator and cannot carry one.
   */
  optionalCoverage: number | null;
  toolsWithIntents: number;
}

/**
 * One row of the project-wide invocation list (#44): every tool call in the
 * range, newest first, with its intent inline when one was captured.
 */
export interface InvocationFeedItem {
  eventId: string;
  timestamp: string;
  toolName: string;
  /** Empty when the call carried no intent. */
  intent: string;
  intentSource: string;
  platform: string;
  status: string;
  latencyMs: number | null;
  errorCategory: string | null;
  errorMessage: string | null;
  /** user_id, else the platform's subject_id; null when the event has neither. */
  userId: string | null;
  sessionId: string;
  traceId: string;
  countryCode: string | null;
  inputValues: string | null;
  outputContent: string | null;
  metadata: string | null;
}

/** Response contract of GET /api/analytics/[projectId]/invocations. */
export interface InvocationsResponse {
  invocations: InvocationFeedItem[];
  total: number;
  kpis: IntentKPIs;
  intentStatus: IntentStatus;
}

/** A captured user intent for one tool call. */
export interface RecentIntent {
  eventId: string;
  timestamp: string;
  intent: string;
  source: string;
  sessionId: string;
  status: string;
}

/**
 * Whether the project's SDK reports intent capture as active.
 * - enabled/disabled: latest connection event carried an explicit flag
 * - unsupported: connections exist but predate SDK 0.2.0 (no flag)
 * - unknown: no connection events at all
 */
export interface IntentStatus {
  status: "enabled" | "disabled" | "unsupported" | "unknown";
  sdkVersion: string | null;
}

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
  /** From the client platform's location (#47); null when not captured. */
  countryCode: string | null;
  isRetry: number;
  inputValues: string | null;
  outputContent: string | null;
  metadata: string | null;
  customEvents: CustomEventEntry[];
}

/**
 * A custom `yavio.track()` event emitted inside the invocation's trace.
 * Integrators that disable input/output capture (privacy policies, app-store
 * requirements) report curated fields this way instead — without surfacing
 * these, their invocations look like no data was collected at all.
 */
export interface CustomEventEntry {
  eventName: string;
  metadata: string;
  timestamp: string;
}

/** Tool metadata from tool_registry. */
export interface ToolRegistryEntry {
  toolName: string;
  description: string | null;
  inputSchema: string;
  registeredAt: string;
  updatedAt: string;
}
