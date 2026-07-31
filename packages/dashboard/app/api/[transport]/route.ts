import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import { getDb } from "@/lib/db";
import {
  type McpAuthContext,
  McpUnavailableError,
  mcpAuthContext,
  preflightMcpAuth,
  verifyMcpBearerToken,
} from "@/lib/mcp/auth";
import { runTool, toolText } from "@/lib/mcp/errors";
import {
  type McpQueryContext,
  type RangeInput,
  appliedFilters,
  resolveDateRange,
  resolvePlatforms,
} from "@/lib/mcp/filters";
import { requireProjectInWorkspace } from "@/lib/mcp/project-access";
import { SCHEMA_DOC } from "@/lib/mcp/schema-doc";
import { validateFreeQuery } from "@/lib/mcp/sql-guard";
import { ANALYTICS_SCOPE, canonicalOrigin } from "@/lib/oauth/constants";
import { hashToken } from "@/lib/oauth/tokens";
import { queryErrorList } from "@/lib/queries/errors";
import { queryIntentFeed, queryIntentKPIs } from "@/lib/queries/intents";
import {
  queryInvocationsTimeSeries,
  queryOverviewKPIs,
  queryPlatformBreakdown,
} from "@/lib/queries/overview";
import {
  queryToolDetailKPIs,
  queryToolErrorCategories,
  queryToolRegistryEntry,
} from "@/lib/queries/tool-detail";
import { queryToolList } from "@/lib/queries/tools";
import { rateLimitConfigs } from "@/lib/rate-limit/config";
import { RateLimiter } from "@/lib/rate-limit/rate-limiter";
import { clientIp } from "@/lib/security/client-ip";
import { projects, workspaces } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Shared input shapes. All tools are read-only and idempotent (ChatGPT retries). */
const rangeShape = {
  from: z.string().optional().describe("Range start, ISO date/datetime (default: 7 days ago)"),
  to: z.string().optional().describe("Range end, ISO date/datetime (default: now)"),
  lookback_days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe("Alternative to from/to: window ending now, in days"),
  platform: z
    .array(z.string())
    .optional()
    .describe('Optional platform filter, e.g. ["chatgpt"] or ["claude"]'),
};

const projectShape = {
  project_id: z.string().uuid().describe("Project id from list_projects"),
  ...rangeShape,
};

async function projectContext(
  auth: McpAuthContext,
  args: { project_id: string } & RangeInput & { platform?: string[] },
): Promise<McpQueryContext> {
  await requireProjectInWorkspace(auth.workspaceId, args.project_id);
  const range = resolveDateRange(args);
  return {
    workspaceId: auth.workspaceId,
    projectId: args.project_id,
    from: range.from,
    to: range.to,
    platform: resolvePlatforms(args.platform),
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_projects",
      {
        title: "List projects",
        description:
          "List the projects (apps) in the authorized workspace. Start here: every other tool needs a project_id from this list.",
        annotations: readOnly,
      },
      async (extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          const db = getDb();
          const [workspace] = await db
            .select({ name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.id, auth.workspaceId))
            .limit(1);
          const rows = await db
            .select({ id: projects.id, name: projects.name, slug: projects.slug })
            .from(projects)
            .where(eq(projects.workspaceId, auth.workspaceId))
            .orderBy(projects.name);
          return toolText({ workspace: workspace?.name ?? null, projects: rows });
        });
      },
    );

    server.registerTool(
      "get_overview",
      {
        title: "Overview KPIs",
        description:
          "Headline numbers for a project and date range: tool invocations, sessions, error rate, latency (with previous-period comparison) plus a platform breakdown. Same definitions as the dashboard.",
        inputSchema: projectShape,
        annotations: readOnly,
      },
      async (args, extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          const ctx = await projectContext(auth, args);
          const [kpis, platforms] = await Promise.all([
            queryOverviewKPIs(ctx),
            queryPlatformBreakdown(ctx),
          ]);
          return toolText({ filters: appliedFilters(ctx), kpis, platforms });
        });
      },
    );

    server.registerTool(
      "get_usage_timeseries",
      {
        title: "Usage over time",
        description:
          "Tool invocations per time bucket for a project — how usage developed over the range.",
        inputSchema: {
          ...projectShape,
          granularity: z.enum(["hour", "day", "week", "month"]).optional(),
        },
        annotations: readOnly,
      },
      async (args, extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          const ctx = await projectContext(auth, args);
          const series = await queryInvocationsTimeSeries(ctx, args.granularity ?? "day");
          return toolText({ filters: appliedFilters(ctx), series });
        });
      },
    );

    server.registerTool(
      "get_top_tools",
      {
        title: "Top tools",
        description:
          "Rank a project's tools by call volume with success rate, error rate and average latency.",
        inputSchema: {
          ...projectShape,
          limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25)"),
        },
        annotations: readOnly,
      },
      async (args, extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          const ctx = await projectContext(auth, args);
          const { tools, total } = await queryToolList(ctx, 1, args.limit ?? 25);
          return toolText({ filters: appliedFilters(ctx), total, tools });
        });
      },
    );

    server.registerTool(
      "get_tool_detail",
      {
        title: "Tool detail",
        description:
          "Drill into one tool of a project: KPIs vs previous period, error categories, and its registered description/schema.",
        inputSchema: {
          ...projectShape,
          tool_name: z.string().min(1).describe("Tool name as reported by get_top_tools"),
        },
        annotations: readOnly,
      },
      async (args, extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          const ctx = await projectContext(auth, args);
          const [kpis, errorCategories, registryEntry] = await Promise.all([
            queryToolDetailKPIs(ctx, args.tool_name),
            queryToolErrorCategories(ctx, args.tool_name),
            queryToolRegistryEntry(ctx, args.tool_name),
          ]);
          return toolText({
            filters: appliedFilters(ctx),
            kpis,
            errorCategories,
            registryEntry,
          });
        });
      },
    );

    server.registerTool(
      "get_errors",
      {
        title: "Recent errors",
        description: "Recent failed tool calls of a project with category, message and platform.",
        inputSchema: {
          ...projectShape,
          limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25)"),
          error_category: z.string().optional().describe("Filter to one error category"),
        },
        annotations: readOnly,
      },
      async (args, extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          const ctx = await projectContext(auth, args);
          const { errors, total } = await queryErrorList(
            ctx,
            1,
            args.limit ?? 25,
            args.error_category,
          );
          return toolText({ filters: appliedFilters(ctx), total, errors });
        });
      },
    );

    server.registerTool(
      "get_recent_intents",
      {
        title: "Recent user intents",
        description:
          "What users were trying to do (captured intents) in a project, with coverage KPIs. Only meaningful where intent capture is enabled.",
        inputSchema: {
          ...projectShape,
          limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25)"),
        },
        annotations: readOnly,
      },
      async (args, extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          const ctx = await projectContext(auth, args);
          const [{ intents, total }, kpis] = await Promise.all([
            queryIntentFeed(ctx, 1, args.limit ?? 25),
            queryIntentKPIs(ctx),
          ]);
          return toolText({ filters: appliedFilters(ctx), kpis, total, intents });
        });
      },
    );

    server.registerTool(
      "get_schema",
      {
        title: "Analytics schema reference",
        description:
          "The tables and columns available to run_query, with semantics and query rules. Read this before writing SQL.",
        annotations: readOnly,
      },
      async (extra) => {
        mcpAuthContext(extra.authInfo);
        return runTool(async () => toolText(SCHEMA_DOC));
      },
    );

    server.registerTool(
      "run_query",
      {
        title: "Run analytics SQL",
        description:
          "Free-form read-only ClickHouse SELECT over the workspace's analytics data, for questions the other tools don't cover. Call get_schema first. Results are hard-limited to the authorized workspace by database row policies.",
        inputSchema: {
          project_id: z.string().uuid().describe("Project id from list_projects"),
          sql: z.string().min(1).describe("A single SELECT statement (ClickHouse dialect)"),
        },
        annotations: readOnly,
      },
      async (args, extra) => {
        const auth = mcpAuthContext(extra.authInfo);
        return runTool(async () => {
          await requireProjectInWorkspace(auth.workspaceId, args.project_id);
          const sql = validateFreeQuery(args.sql);
          const rows = await queryAnalytics<Record<string, unknown>>({
            workspaceId: auth.workspaceId,
            projectId: args.project_id,
            query: sql,
            settings: {
              // Hard limits, not truncation — ClickHouse throws on overflow.
              // The read budget has to clear a full 90-day scan of a busy
              // project, or plain aggregates would fail where the curated
              // tools (running the same scan) succeed. max_result_bytes caps
              // the RESPONSE: input_values/output_content are unbounded
              // strings, so a 10k-row select of them would otherwise build an
              // arbitrarily large string in this shared process.
              max_execution_time: 30,
              max_result_rows: 10_000,
              max_result_bytes: 32_000_000,
              max_rows_to_read: 50_000_000,
              max_bytes_to_read: 5_000_000_000,
            },
          });
          if (rows.length === 0) {
            return toolText({
              rows: [],
              note: "Empty result. Row policies restrict every query to the authorized workspace AND to the project_id you passed; also check the time filter.",
            });
          }
          // Second cap, on what we serialise: the model has to read this, and
          // the process has to hold it. Truncate loudly rather than build a
          // huge string.
          // Measure while accumulating — stringifying the whole set just to
          // check its length would build the very multi-megabyte string this
          // cap exists to avoid.
          const MAX_RESPONSE_CHARS = 200_000;
          const kept: Record<string, unknown>[] = [];
          let size = 0;
          for (const row of rows) {
            size += JSON.stringify(row).length + 1;
            if (size > MAX_RESPONSE_CHARS && kept.length > 0) break;
            kept.push(row);
            // A single row over the cap is kept so the caller sees its shape
            // rather than an empty result they cannot diagnose.
            if (size > MAX_RESPONSE_CHARS) break;
          }
          if (kept.length === rows.length) {
            return toolText({ rowCount: rows.length, rows });
          }
          return toolText({
            rowCount: rows.length,
            truncated: true,
            note: `Result too large to return in full; showing the first ${kept.length} of ${rows.length} rows. Aggregate or select fewer columns.`,
            rows: kept,
          });
        });
      },
    );
  },
  {
    serverInfo: { name: "yavio-analytics", version: "1.0.0" },
    capabilities: {},
    instructions:
      "Read-only analytics for the connected Yavio workspace (MCP/ChatGPT app usage: tool calls, sessions, users, errors, intents). Call list_projects first, then query per project. For anything the curated tools don't answer, read get_schema and use run_query.",
  },
  {
    basePath: "/api",
    maxDuration: 60,
    disableSse: true,
  },
);

const authHandler = withMcpAuth(handler, verifyMcpBearerToken, {
  required: true,
  requiredScopes: [ANALYTICS_SCOPE],
  resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
  // Pin the origin. Without this, mcp-handler derives it from
  // X-Forwarded-Host, so a spoofed header would point the 401 challenge's
  // resource_metadata at an attacker-chosen document — and from there at an
  // attacker-chosen authorization server. Every other URL here is pinned the
  // same way.
  // mcp-handler treats this as the ORIGIN it joins resourceMetadataPath onto.
  resourceUrl: canonicalOrigin(),
});

// Same budget as the per-user analytics rate limit in the HTTP routes, keyed
// by bearer token (≈ per user/connector) so one runaway agent loop cannot
// monopolize ClickHouse.
const limiter = new RateLimiter(rateLimitConfigs.analytics);
limiter.start();

async function route(
  request: Request,
  { params }: { params: Promise<{ transport: string }> },
): Promise<Response> {
  const { transport } = await params;
  // Only the Streamable HTTP transport at /api/mcp exists; /api/sse is
  // deliberately not served (stateless deployment, no Redis).
  if (transport !== "mcp") {
    return new Response("Not found", { status: 404 });
  }

  // Keyed by the HASH of the presented bearer, falling back to the client IP
  // when there is none. Hosted clients reach us from a handful of vendor
  // egress IPs, so an IP key would put every customer in one bucket and let a
  // single runaway agent throttle everyone; the raw bearer would keep live
  // secrets in the heap and let an attacker mint a fresh bucket per request.
  // The hash is bounded, unguessable and per-connector.
  const presented = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const limiterKey = presented ? `t:${hashToken(presented)}` : `ip:${clientIp(request)}`;
  const limit = limiter.consume(limiterKey);
  if (!limit.allowed) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Rate limited, retry shortly" },
        id: null,
      },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  try {
    // Verify BEFORE mcp-handler: it converts every throw from its verifyToken
    // hook into 401 invalid_token, which clients read as "grant is dead".
    await preflightMcpAuth(request);
    return await authHandler(request);
  } catch (err) {
    if (err instanceof McpUnavailableError) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Analytics backend temporarily unavailable" },
          id: null,
        },
        { status: 503, headers: { "Retry-After": "10" } },
      );
    }
    throw err;
  }
}

export { route as GET, route as POST, route as DELETE };
