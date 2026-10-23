/**
 * #144 on a per-request host, end to end: a new McpServer per HTTP request,
 * one `createYavio()` client, 50 calls from one client. The same cases run on
 * MCP SDK v1 (stateless-e2e.test.ts) and on v2 in both protocol eras
 * (mcp-v2.test.ts); each file passes the stack, so its imports stay its own.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deriveCustomSessionId, deriveSessionId } from "../../core/ids.js";
import type { SessionKeyRequest, WithYavioOptions } from "../../core/types.js";
import { createYavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { type MockIngest, startMockIngest } from "./helpers.js";

/** A server under test: what the stack's McpServer offers for registering a tool. */
export interface ToolServer {
  registerTool: (...args: never[]) => unknown;
  connect: (...args: never[]) => Promise<unknown>;
}

/** A connected client of the stack. */
export interface StackClient {
  callTool(call: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

/** One MCP SDK stack: how a per-request host and its client are built. */
export interface PerRequestStack {
  /** Shown in the test names: `v1`, `v2 2025 era`, `v2 2026-07-28 era`. */
  name: string;
  /** A new, unconnected McpServer of the stack. */
  newServer(): ToolServer;
  /**
   * The Node request handler of a per-request host: `build()` returns the
   * (wrapped) server for one request; `auth`, when set, is what an auth
   * middleware would put on `req.auth`.
   */
  handler(
    build: () => ToolServer,
    auth?: Record<string, unknown>,
  ): (req: never, res: never) => void;
  /** A client connected to `url`, sending `headers` on every request. */
  connect(
    url: URL,
    client: { name: string; version: string },
    headers?: Record<string, string>,
  ): Promise<StackClient>;
}

const API_KEY = "yav_session_key";
const CALLS = 50;

export function perRequestSessionSuite(stack: PerRequestStack): void {
  describe(`session keys on a per-request host, ${stack.name} (#144)`, () => {
    let ingest: MockIngest;
    let http: ReturnType<typeof createServer> | undefined;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      _resetGlobalState();
      ingest = await startMockIngest();
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(async () => {
      warn.mockRestore();
      await ingest.close();
      if (http) {
        // The client's keep-alive sockets would hold close() for the
        // server's keepAliveTimeout (about 4 s per test on v1).
        http.closeAllConnections();
        await new Promise<void>((resolve) => http?.close(() => resolve()));
      }
      http = undefined;
      _resetGlobalState();
    });

    const lines1102 = () =>
      warn.mock.calls.filter((args: unknown[]) => String(args[0]).includes("YAVIO-1102"));

    /** A per-request host for `options`; returns its URL. */
    async function host(
      options: WithYavioOptions = {},
      auth?: Record<string, unknown>,
    ): Promise<{ url: URL; yavio: ReturnType<typeof createYavio> }> {
      const yavio = createYavio({
        apiKey: API_KEY,
        endpoint: ingest.endpoint,
        serverOnly: true,
        ...options,
      });
      const build = () => {
        const server = stack.newServer();
        (server.registerTool as unknown as (...a: unknown[]) => unknown)(
          "get_price",
          { description: "Price of a SKU", inputSchema: { sku: z.string() } },
          async ({ sku }: { sku: string }) => ({
            content: [{ type: "text" as const, text: `price of ${sku}` }],
          }),
        );
        return yavio.wrap(server);
      };
      const listener = stack.handler(build, auth);
      const server = createServer((req, res) => listener(req as never, res as never));
      http = server;
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
      return { url, yavio };
    }

    /** `count` calls from one client, each result checked. */
    async function calls(
      url: URL,
      options: {
        client?: { name: string; version: string };
        headers?: Record<string, string>;
        meta?: Record<string, unknown>;
        count?: number;
      } = {},
    ): Promise<void> {
      const client = await stack.connect(
        url,
        options.client ?? { name: "plain-client", version: "1.0" },
        options.headers,
      );
      for (let i = 0; i < (options.count ?? CALLS); i++) {
        const result = (await client.callTool({
          name: "get_price",
          arguments: { sku: `S${i}` },
          ...(options.meta ? { _meta: options.meta } : {}),
        })) as { content?: unknown; isError?: unknown };
        // The tool result is the handler's, whatever the session key did.
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: "text", text: `price of S${i}` }]);
      }
      await client.close();
    }

    const toolCalls = () => ingest.ofType("tool_call");
    const connections = () => ingest.ofType("connection");
    const sessionIds = () => new Set(toolCalls().map((e) => e.session_id));
    const sources = () => new Set(ingest.events.map((e) => e.session_source));

    it("sessionKey from a header: 50 calls → 1 session (the keyed hash), 1 connection, custom on every event", async () => {
      const { url, yavio } = await host({
        sessionKey: ({ headers }) => headers["x-conversation-id"],
      });
      await calls(url, { headers: { "x-conversation-id": "conv-header-1" } });
      await yavio.shutdown();

      expect(toolCalls()).toHaveLength(CALLS);
      expect(sessionIds().size).toBe(1);
      expect(connections()).toHaveLength(1);
      expect(sources()).toEqual(new Set(["custom"]));
      expect(sessionIds()).toEqual(new Set([deriveCustomSessionId(API_KEY, "conv-header-1")]));
      // Keyed: not the unkeyed hash anyone could recompute from the value.
      expect(sessionIds().has(deriveSessionId("conv-header-1"))).toBe(false);
      expect(connections()[0]?.session_id).toBe(deriveCustomSessionId(API_KEY, "conv-header-1"));
      expect(lines1102()).toHaveLength(0);
    });

    it("authInfo plumbing: what an auth middleware set as req.auth reaches sessionKey (a mechanics test, not a key to use)", async () => {
      const seen: SessionKeyRequest[] = [];
      const { url, yavio } = await host(
        {
          sessionKey: (request) => {
            seen.push(request);
            const sub = request.authInfo?.extra?.sub;
            return typeof sub === "string" ? sub : undefined;
          },
        },
        { token: "bearer-1", clientId: "client-1", scopes: ["read"], extra: { sub: "user-1" } },
      );
      await calls(url);
      await yavio.shutdown();

      expect(sessionIds().size).toBe(1);
      expect(connections()).toHaveLength(1);
      expect(sources()).toEqual(new Set(["custom"]));
      expect(sessionIds()).toEqual(new Set([deriveCustomSessionId(API_KEY, "user-1")]));
      // The same request shape on every stack: lower-cased headers, the
      // request _meta, the auth info, the raw context.
      expect(seen).toHaveLength(CALLS);
      expect(seen[0]?.authInfo).toMatchObject({ clientId: "client-1", extra: { sub: "user-1" } });
      expect(typeof seen[0]?.headers["user-agent"]).toBe("string");
      expect(seen[0]?.headers).not.toHaveProperty("User-Agent");
      expect(seen[0]?.meta).toBeTypeOf("object");
      expect(seen[0]?.extra).toBeTypeOf("object");
    });

    it("50 key-less calls → 50 tool_call labelled per_request and 1 connection; two clients → 2", async () => {
      const { url, yavio } = await host();
      await calls(url, {
        client: { name: "cursor", version: "1.7.0" },
        headers: { "user-agent": "cursor/1.7.0" },
      });
      await yavio.shutdown();

      expect(toolCalls()).toHaveLength(CALLS);
      expect(toolCalls().every((e) => e.session_source === "per_request")).toBe(true);
      // One session per request: what the read side does not count.
      expect(sessionIds().size).toBe(CALLS);
      expect(connections()).toHaveLength(1);
      expect(connections()[0]?.session_source).toBe("per_request");
      expect(connections()[0]?.client_name).toBe("cursor");

      // A second client, then the first again: one more connection, not 50.
      await calls(url, {
        client: { name: "mcp-inspector", version: "0.17.0" },
        headers: { "user-agent": "mcp-inspector/0.17.0" },
        count: 5,
      });
      await calls(url, {
        client: { name: "cursor", version: "1.7.0" },
        headers: { "user-agent": "cursor/1.7.0" },
        count: 5,
      });
      await yavio.shutdown();
      expect(connections().map((e) => e.client_name)).toEqual(["cursor", "mcp-inspector"]);
    });

    it("_meta['vscode.conversationId'] → 1 session, vscode_conversation, with no option set", async () => {
      const { url, yavio } = await host();
      await calls(url, { meta: { "vscode.conversationId": "vscode-conv-1" } });
      await yavio.shutdown();

      expect(sessionIds().size).toBe(1);
      expect(connections()).toHaveLength(1);
      expect(sources()).toEqual(new Set(["vscode_conversation"]));
      expect(sessionIds()).toEqual(new Set([deriveSessionId("vscode-conv-1")]));
    });

    it("_meta.threadId from codex-mcp-client → 1 session, codex_thread; the same threadId from another client → per_request", async () => {
      const { url, yavio } = await host();
      await calls(url, {
        client: { name: "codex-mcp-client", version: "0.164.0" },
        headers: { "user-agent": "codex-mcp-client/0.164.0" },
        meta: { threadId: "thread-1" },
      });
      await yavio.shutdown();

      expect(sessionIds().size).toBe(1);
      expect(sources()).toEqual(new Set(["codex_thread"]));
      expect(sessionIds()).toEqual(new Set([deriveSessionId("thread-1")]));

      // A bare threadId from a client the SDK does not know could be
      // anything: never a session key.
      ingest.events.length = 0;
      await calls(url, {
        client: { name: "node-client", version: "1.0" },
        headers: { "user-agent": "node" },
        meta: { threadId: "thread-1" },
        count: 5,
      });
      await yavio.shutdown();
      expect(toolCalls()).toHaveLength(5);
      expect(toolCalls().every((e) => e.session_source === "per_request")).toBe(true);
      expect(sessionIds().size).toBe(5);
    });

    it("openai/session beats sessionKey, and sessionKey is not called", async () => {
      const sessionKey = vi.fn(() => "never-used");
      const { url, yavio } = await host({ sessionKey });
      await calls(url, { meta: { "openai/session": "conv-openai-1" } });
      await yavio.shutdown();

      expect(sessionIds()).toEqual(new Set([deriveSessionId("conv-openai-1")]));
      expect(sources()).toEqual(new Set(["openai_session"]));
      expect(sessionKey).not.toHaveBeenCalled();
    });

    it.each([
      [
        "throws",
        () => {
          throw new Error("no conversation header");
        },
      ],
      // An async function: its rejection must not become an unhandled one.
      ["returns a rejecting promise", () => Promise.reject(new Error("async lookup failed"))],
      ["returns a non-string", () => 42],
      ["returns more than 1 024 characters", () => "k".repeat(1025)],
    ])(
      "a sessionKey that %s → per_request, one YAVIO-1102 line per process, the result unchanged",
      async (_label, sessionKey) => {
        const { url, yavio } = await host({
          sessionKey: sessionKey as unknown as WithYavioOptions["sessionKey"],
        });
        await calls(url, { count: 5 });
        await yavio.shutdown();

        expect(toolCalls()).toHaveLength(5);
        expect(toolCalls().every((e) => e.session_source === "per_request")).toBe(true);
        expect(lines1102()).toHaveLength(1);
        expect(String(lines1102()[0]?.[0])).toContain("sessionKey");
      },
    );
  });
}
