// What the MCP route lists and accepts, through the real mcp-handler and
// McpServer: the JSON Schemas are what LLM clients read. zod 4's converter
// changed them in two ways (no `additionalProperties: false`, a strict
// `z.uuid()`); the route keeps the zod 3 schema and acceptance.
import { beforeAll, describe, expect, it, vi } from "vitest";

const captured: { handler?: (request: Request) => Promise<Response> } = {};

vi.mock("mcp-handler", async (importOriginal) => {
  const real = await importOriginal<typeof import("mcp-handler")>();
  return {
    ...real,
    createMcpHandler: (...args: Parameters<typeof real.createMcpHandler>) => {
      const handler = real.createMcpHandler(...args);
      captured.handler = handler as unknown as (request: Request) => Promise<Response>;
      return handler;
    },
  };
});
// Past argument validation, every tool asks for its auth context first.
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  mcpAuthContext: () => {
    throw new Error("HANDLER_REACHED");
  },
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

type Tool = { name: string; inputSchema: Record<string, unknown> };

let id = 0;
async function rpc(method: string, params: unknown) {
  const handler = captured.handler;
  if (!handler) throw new Error("createMcpHandler was not called");
  const response = await handler(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
  );
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text);
}

/** "reached" when the arguments passed validation, "rejected" when they did not. */
async function call(name: string, args: Record<string, unknown>) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  const text: string = result.content[0].text;
  if (text.includes("HANDLER_REACHED")) return "reached";
  expect(text).toMatch(/Input validation error/);
  return "rejected";
}

let tools: Tool[];

beforeAll(async () => {
  await import("@/app/api/[transport]/route");
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  tools = (await rpc("tools/list", {})).result.tools;
});

describe("MCP tools/list", () => {
  it("forbids unlisted arguments in every input schema with parameters", () => {
    const withParameters = tools.filter(
      (tool) => Object.keys((tool.inputSchema.properties as object | undefined) ?? {}).length > 0,
    );
    expect(withParameters.map((tool) => tool.name)).toEqual([
      "get_overview",
      "get_usage_timeseries",
      "get_top_tools",
      "get_tool_detail",
      "get_errors",
      "get_recent_intents",
      "run_query",
    ]);
    for (const tool of withParameters) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.inputSchema.required, tool.name).toContain("project_id");
    }
  });

  it("describes project_id as a UUID", () => {
    const run = tools.find((tool) => tool.name === "run_query");
    expect(run?.inputSchema.properties).toMatchObject({
      project_id: { type: "string", format: "uuid", description: "Project id from list_projects" },
      sql: { type: "string", minLength: 1 },
    });
  });
});

describe("MCP argument validation", () => {
  it("takes UUID-shaped project ids of any version, as zod 3's .uuid() did", async () => {
    expect(
      await call("run_query", {
        project_id: "11111111-1111-1111-1111-111111111111",
        sql: "SELECT 1",
      }),
    ).toBe("reached");
    expect(await call("run_query", { project_id: "not-a-uuid", sql: "SELECT 1" })).toBe("rejected");
  });

  it("strips an unlisted argument rather than rejecting the call", async () => {
    expect(
      await call("get_overview", { project_id: "550e8400-e29b-41d4-a716-446655440000", extra: 1 }),
    ).toBe("reached");
  });
});
