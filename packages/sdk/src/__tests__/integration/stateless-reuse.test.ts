/**
 * #169: one stateless Streamable HTTP transport reused for every request of a
 * long-lived server. MCP SDK v1 1.24 and 1.25 allow it; from 1.26.0 the
 * transport refuses a second request ("Stateless transport cannot be reused
 * across requests"), so the suite runs on the compat floor leg (1.24.0) and
 * is skipped on every later version. A key-less call on it used to resolve
 * to the proxy's one connection session: the first identified user, its
 * traits, its platform and the step sequence landed on every later caller.
 */
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createYavio, yavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { type MockIngest, registeredTool, startMockIngest } from "./helpers.js";

/** The installed MCP SDK v1 version, read from its package.json (not exported). */
function installedV1Version(): string {
  let dir = dirname(
    createRequire(import.meta.url).resolve("@modelcontextprotocol/sdk/server/mcp.js"),
  );
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@modelcontextprotocol/sdk") return pkg.version;
    } catch {
      // Not this directory.
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("@modelcontextprotocol/sdk package.json not found");
    dir = parent;
  }
}
const [major, minor] = installedV1Version().split(".").map(Number);
/** 1.26.0 made a stateless transport single-use. */
const reuseAllowed = major === 1 && (minor ?? 0) < 26;

describe.skipIf(!reuseAllowed)(
  "a long-lived v1 server on ONE reused stateless transport (MCP SDK 1.24/1.25, #169)",
  () => {
    let ingest: MockIngest;
    let http: Server | undefined;

    beforeEach(async () => {
      _resetGlobalState();
      ingest = await startMockIngest();
    });

    afterEach(async () => {
      if (http) {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http?.close(() => resolve()));
      }
      http = undefined;
      await ingest.close();
      _resetGlobalState();
      vi.restoreAllMocks();
    });

    async function start(apiKey: string) {
      const analytics = createYavio({ apiKey, endpoint: ingest.endpoint, serverOnly: true });
      const server = analytics.wrap(new McpServer({ name: "long-lived", version: "1.0" }));
      server.registerTool(
        "whoami",
        { description: "d", inputSchema: { user: z.string(), identify: z.boolean().optional() } },
        async ({ user, identify }) => {
          if (identify !== false) yavio.identify(user, { plan: `plan-${user}` });
          yavio.step("first");
          yavio.step("second");
          return { content: [{ type: "text" as const, text: user }] };
        },
      );
      // A handler that invokes another wrapped tool's registered handler
      // directly, with a context it built itself (no requestInfo).
      server.registerTool("inner", { description: "d" }, async () => {
        yavio.step("inner");
        return { content: [{ type: "text" as const, text: "in" }] };
      });
      server.registerTool(
        "outer",
        { description: "d", inputSchema: { user: z.string() } },
        async ({ user }) => {
          yavio.identify(user);
          await registeredTool(server, "inner")?.handler({});
          return { content: [{ type: "text" as const, text: user }] };
        },
      );
      // ONE transport, connected once, for every request of the process.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      http = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
        });
      });
      await new Promise<void>((resolve) => http?.listen(0, "127.0.0.1", resolve));
      const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
      // One client after the other: MCP SDK clients number their requests
      // from 0, and colliding JSON-RPC ids hang a reused transport.
      const callAs = async (
        clientName: string,
        args: { user: string; identify?: boolean },
        meta?: Record<string, unknown>,
        tool = "whoami",
      ) => {
        const client = new Client({ name: clientName, version: "1.0" });
        await client.connect(new StreamableHTTPClientTransport(url));
        try {
          await client.callTool({
            name: tool,
            arguments: args,
            ...(meta ? { _meta: meta } : {}),
          });
        } finally {
          await client.close();
        }
      };
      return { analytics, callAs };
    }

    it("three callers identify three users: each call carries its own user_id (or none), session_id, platform and step sequence; no YAVIO-1302", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { analytics, callAs } = await start("yav_169_reuse");
      await callAs("claude-code", { user: "alice" });
      await callAs("cursor", { user: "bob" });
      await callAs("client-carol", { user: "carol" });
      await callAs("client-dave", { user: "dave", identify: false });
      await analytics.shutdown();

      const calls = ingest.ofType("tool_call");
      expect(calls.map((e) => e.user_id ?? null)).toEqual(["alice", "bob", "carol", null]);
      expect(calls.every((e) => e.session_source === "per_request")).toBe(true);
      expect(new Set(calls.map((e) => e.session_id)).size).toBe(4);
      // Each caller's own client, not the first caller's.
      expect(calls.map((e) => e.platform)).toEqual(["claude-code", "cursor", "unknown", "unknown"]);
      // Every call's steps start at 1, on that call's session.
      const steps = ingest.ofType("step");
      expect(steps.map((e) => [e.session_id, e.user_id ?? null, e.step_sequence])).toEqual(
        calls.flatMap((c) => [
          [c.session_id, c.user_id ?? null, 1],
          [c.session_id, c.user_id ?? null, 2],
        ]),
      );
      expect(ingest.ofType("identify").map((e) => [e.user_id, e.user_traits])).toEqual([
        ["alice", { plan: "plan-alice" }],
        ["bob", { plan: "plan-bob" }],
        ["carol", { plan: "plan-carol" }],
      ]);
      expect(warn.mock.calls.filter((args) => String(args[0]).includes("YAVIO-1302"))).toEqual([]);
      // #144's per_request connection dedup is by client, unchanged: one per
      // client, each on the session of the call that emitted it and with
      // that client's own platform.
      expect(
        ingest.ofType("connection").map((e) => [e.client_name, e.platform, e.session_id]),
      ).toEqual([
        ["claude-code", "claude-code", calls[0]?.session_id],
        ["cursor", "cursor", calls[1]?.session_id],
        ["client-carol", "unknown", calls[2]?.session_id],
        ["client-dave", "unknown", calls[3]?.session_id],
      ]);
    });

    it("a call with a key keeps its conversation across calls on the same transport, around a key-less caller", async () => {
      const { analytics, callAs } = await start("yav_169_keyed");
      await callAs("claude-code", { user: "alice" }, { "openai/session": "conv-1" });
      await callAs("cursor", { user: "bob" });
      await callAs(
        "claude-code",
        { user: "alice", identify: false },
        { "openai/session": "conv-1" },
      );
      await analytics.shutdown();

      const calls = ingest.ofType("tool_call");
      expect(calls.map((e) => [e.user_id ?? null, e.session_source])).toEqual([
        ["alice", "openai_session"],
        ["bob", "per_request"],
        ["alice", "openai_session"],
      ]);
      expect(calls[0]?.session_id).toBe(calls[2]?.session_id);
      expect(calls[1]?.session_id).not.toBe(calls[0]?.session_id);
      // The conversation's step sequence continues; the key-less call's starts at 1.
      expect(ingest.ofType("step").map((e) => e.step_sequence)).toEqual([1, 2, 1, 2, 3, 4]);
    });

    it("a handler invoking another wrapped tool's handler with a context of its own: each caller's inner call stays in that caller's session (#169 review round 1)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { analytics, callAs } = await start("yav_169_nested");
      await callAs("claude-code", { user: "u1" }, undefined, "outer");
      await callAs("cursor", { user: "u2" }, undefined, "outer");
      await analytics.shutdown();

      const calls = ingest.ofType("tool_call");
      expect(calls.map((e) => [e.event_name, e.user_id ?? null, e.session_source])).toEqual([
        ["inner", "u1", "per_request"],
        ["outer", "u1", "per_request"],
        ["inner", "u2", "per_request"],
        ["outer", "u2", "per_request"],
      ]);
      expect(calls[0]?.session_id).toBe(calls[1]?.session_id);
      expect(calls[2]?.session_id).toBe(calls[3]?.session_id);
      expect(calls[2]?.session_id).not.toBe(calls[0]?.session_id);
      expect(ingest.ofType("step").map((e) => [e.session_id, e.user_id, e.step_sequence])).toEqual([
        [calls[0]?.session_id, "u1", 1],
        [calls[2]?.session_id, "u2", 1],
      ]);
      // One connection event per caller, on its session: the inner call
      // joined it and adds none, although its context names no protocol
      // version (#169 review round 2; 0.5.4 added one labelled `connection`).
      expect(
        ingest
          .ofType("connection")
          .map((e) => [e.client_name, e.session_id, e.session_source, e.protocol_version ?? null]),
      ).toEqual([
        ["claude-code", calls[0]?.session_id, "per_request", expect.any(String)],
        ["cursor", calls[2]?.session_id, "per_request", expect.any(String)],
      ]);
      expect(warn.mock.calls.filter((args) => String(args[0]).includes("YAVIO-1302"))).toEqual([]);
    });
  },
);
