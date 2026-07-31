import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/oauth/store", () => ({ verifyAccessToken: vi.fn() }));
vi.mock("../lib/auth/workspace-access", () => ({ checkWorkspaceAccess: vi.fn() }));
const db = { select: vi.fn() };
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => db) }));

import { checkWorkspaceAccess } from "../lib/auth/workspace-access";
import { AnalyticsQueryError } from "../lib/clickhouse/analytics-client";
import { mcpAuthContext, verifyMcpBearerToken } from "../lib/mcp/auth";
import { McpToolError, runTool, toolError, toolText } from "../lib/mcp/errors";
import { appliedFilters, resolveDateRange, resolvePlatforms } from "../lib/mcp/filters";
import { requireProjectInWorkspace } from "../lib/mcp/project-access";
import { verifyAccessToken } from "../lib/oauth/store";

const mockVerify = verifyAccessToken as ReturnType<typeof vi.fn>;
const mockAccess = checkWorkspaceAccess as ReturnType<typeof vi.fn>;

const VALID_TOKEN = {
  userId: "user-1",
  workspaceId: "ws-1",
  clientId: "yvc_x",
  scope: "analytics:read",
  audience: "https://dashboard.test/api/mcp",
};

describe("verifyMcpBearerToken", () => {
  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", "https://dashboard.test");
    vi.stubEnv("APP_URL", "https://dashboard.test");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects missing/unknown tokens", async () => {
    expect(await verifyMcpBearerToken(new Request("https://x"), undefined)).toBeUndefined();
    mockVerify.mockResolvedValue(null);
    expect(await verifyMcpBearerToken(new Request("https://x"), "yvo_at_x")).toBeUndefined();
  });

  it("rejects tokens minted for a different audience (RFC 8707)", async () => {
    mockVerify.mockResolvedValue({ ...VALID_TOKEN, audience: "https://other.example/api/mcp" });
    mockAccess.mockResolvedValue({ role: "owner", isOwner: true });
    expect(await verifyMcpBearerToken(new Request("https://x"), "yvo_at_x")).toBeUndefined();
  });

  it("rejects tokens whose user lost workspace membership (live re-check)", async () => {
    mockVerify.mockResolvedValue(VALID_TOKEN);
    mockAccess.mockResolvedValue(null);
    expect(await verifyMcpBearerToken(new Request("https://x"), "yvo_at_x")).toBeUndefined();
  });

  it("returns AuthInfo with workspace context on success", async () => {
    mockVerify.mockResolvedValue(VALID_TOKEN);
    mockAccess.mockResolvedValue({ role: "member", isOwner: false });
    const authInfo = await verifyMcpBearerToken(new Request("https://x"), "yvo_at_x");
    expect(authInfo?.clientId).toBe("yvc_x");
    expect(authInfo?.scopes).toEqual(["analytics:read"]);
    expect(mcpAuthContext(authInfo)).toEqual({
      userId: "user-1",
      workspaceId: "ws-1",
      role: "member",
    });
  });

  it("mcpAuthContext throws without an authenticated context", () => {
    expect(() => mcpAuthContext(undefined)).toThrow();
  });
});

describe("requireProjectInWorkspace", () => {
  function chainSelect(rows: unknown[]) {
    db.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }));
  }

  it("rejects unknown projects and foreign-workspace projects with the SAME message", async () => {
    chainSelect([]);
    const unknownError = await requireProjectInWorkspace("ws-1", "p-x").catch((e) => e.message);
    chainSelect([{ id: "p-1", name: "P", slug: "p", workspaceId: "ws-OTHER" }]);
    const foreignError = await requireProjectInWorkspace("ws-1", "p-1").catch((e) => e.message);
    expect(unknownError).toBe(foreignError);
  });

  it("returns the project when it belongs to the workspace", async () => {
    chainSelect([{ id: "p-1", name: "P", slug: "p", workspaceId: "ws-1" }]);
    expect(await requireProjectInWorkspace("ws-1", "p-1")).toEqual({
      id: "p-1",
      name: "P",
      slug: "p",
    });
  });
});

describe("runTool error boundary", () => {
  it("maps McpToolError and AnalyticsQueryError to isError results", async () => {
    const toolFailure = await runTool(async () => {
      throw new McpToolError("bad input");
    });
    expect(toolFailure.isError).toBe(true);
    expect(toolFailure.content[0].text).toBe("bad input");

    const queryFailure = await runTool(async () => {
      throw new AnalyticsQueryError("YAVIO-1", "query timed out", 504);
    });
    expect(queryFailure.isError).toBe(true);
    expect(queryFailure.content[0].text).toContain("YAVIO-1");

    const unknownFailure = await runTool(async () => {
      throw new Error("secret internals");
    });
    expect(unknownFailure.isError).toBe(true);
    expect(unknownFailure.content[0].text).not.toContain("secret internals");
  });

  it("passes successful results through", async () => {
    const result = await runTool(async () => toolText({ ok: true }));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('{"ok":true}');
    expect(toolError("x").isError).toBe(true);
  });
});

describe("date range + platform filters", () => {
  it("defaults to a 7-day window and clamps lookback to 90 days", () => {
    const defaultRange = resolveDateRange({});
    const spanMs =
      new Date(`${defaultRange.to}Z`).getTime() - new Date(`${defaultRange.from}Z`).getTime();
    expect(Math.round(spanMs / 86_400_000)).toBe(7);

    const clamped = resolveDateRange({ lookback_days: 500 });
    const clampedSpan =
      new Date(`${clamped.to}Z`).getTime() - new Date(`${clamped.from}Z`).getTime();
    expect(Math.round(clampedSpan / 86_400_000)).toBe(90);
  });

  it("accepts explicit ISO dates and formats them for ClickHouse", () => {
    const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-15T12:00:00Z" });
    expect(range.from).toBe("2026-07-01 00:00:00.000");
    expect(range.to).toBe("2026-07-15 12:00:00.000");
  });

  it("rejects invalid dates and inverted ranges", () => {
    expect(() => resolveDateRange({ from: "not-a-date" })).toThrow(McpToolError);
    expect(() => resolveDateRange({ from: "2026-07-15", to: "2026-07-01" })).toThrow(McpToolError);
  });

  it("REJECTS unknown platforms rather than silently returning unfiltered totals", () => {
    // silently dropping would answer 'how many ChatGPT calls?' with the
    // project-wide number, and the model could not tell
    expect(() => resolvePlatforms(["chatgpt", "not-a-platform"])).toThrow(McpToolError);
    expect(() => resolvePlatforms(["ChatGPT"])).toThrow(/Unknown platform/);
    expect(() => resolvePlatforms(["bogus"])).toThrow(McpToolError);
    expect(resolvePlatforms(["chatgpt"])).toEqual(["chatgpt"]);
    expect(resolvePlatforms([])).toBeUndefined();
    expect(resolvePlatforms(undefined)).toBeUndefined();
  });

  it("appliedFilters echoes what was actually applied, incl. 'all' when unfiltered", () => {
    expect(appliedFilters({ workspaceId: "w", projectId: "p", from: "F", to: "T" })).toEqual({
      from: "F",
      to: "T",
      platform: "all",
    });
    expect(
      appliedFilters({
        workspaceId: "w",
        projectId: "p",
        from: "F",
        to: "T",
        platform: ["chatgpt"],
      }),
    ).toEqual({ from: "F", to: "T", platform: ["chatgpt"] });
  });
});
