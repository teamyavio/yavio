/**
 * `client.flush()` and `client.flushWhenSent()` (#171): deliver what is
 * queued now, for hosts that freeze or throttle the instance once the
 * response is out (AWS Lambda, Vercel Functions, Cloud Run with request-based
 * billing, Cloudflare Workers, Netlify Functions). Bounded by
 * `flushTimeoutMs`, never rejects, never drops, keeps the hold and the
 * transport. The freeze itself is exercised in `freeze-process.test.ts` and
 * `lambda-process.test.ts`; the transport rules (C1–C3) in
 * `http-transport.test.ts`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerV2, createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { _resetConfigWarnings } from "../../core/config.js";
import { createYavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { _setSignalReraise, _sharedStateCount } from "../../server/shared.js";
import { type MockIngest, callTool, refusedEndpoint, startMockIngest } from "./helpers.js";

const ok = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Emit with every other listener detached (vitest has its own), then put them back. */
function emitAlone(signal: NodeJS.Signals): void {
  const others = process.rawListeners(signal) as Array<(...args: unknown[]) => void>;
  const ours = others.filter((l) => !String(l).includes("onSignal"));
  for (const l of ours) process.off(signal, l);
  try {
    process.emit(signal, signal);
  } finally {
    for (const l of ours) process.on(signal, l);
  }
}

let ingest: MockIngest;
let warn: { mock: { calls: unknown[][] } };
let error: { mock: { calls: unknown[][] } };
const lines = (): string[] => warn.mock.calls.map((c) => String(c[0]));
const flushLines = () => lines().filter((l) => l.includes("YAVIO-1208"));
const calls = () => ingest.ofType("tool_call").length;

/** One wrapped server per "request", one tool call on it: one tool_call queued. */
async function invoke(analytics: ReturnType<typeof createYavio>): Promise<void> {
  const raw = new McpServer({ name: "fn", version: "1.0" });
  raw.registerTool("echo", { inputSchema: { q: z.string() } }, ok);
  analytics.wrap(raw);
  await callTool(raw, "echo", { q: "x" });
}

beforeEach(async () => {
  _resetGlobalState();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  ingest = await startMockIngest();
});

afterEach(async () => {
  _resetGlobalState();
  vi.restoreAllMocks();
  await ingest.answerHung();
  await ingest.close();
});

describe("flush() (#171)", () => {
  it("delivers everything queued and keeps the hold and the transport, arming no exit report: the next request's event goes out with the next flush", async () => {
    const analytics = createYavio({
      apiKey: "yav_f1",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const exitListeners = process.listenerCount("exit");
    await invoke(analytics);
    expect(calls()).toBe(0); // buffered: the interval is 10 s
    await analytics.flush();
    expect(calls()).toBe(1);
    expect(_sharedStateCount()).toBe(1); // the hold and the transport stay
    expect(process.listenerCount("exit")).toBe(exitListeners); // no exit report armed
    await invoke(analytics);
    await analytics.flush();
    expect(calls()).toBe(2);
    expect(ingest.batches).toHaveLength(2);
    expect(flushLines()).toEqual([]);
  });

  it("flushes the key's transport for every client on it: another client's events go out with this client's flush", async () => {
    const a = createYavio({ apiKey: "yav_shared", endpoint: ingest.endpoint, serverOnly: true });
    const b = createYavio({ apiKey: "yav_shared", endpoint: ingest.endpoint, serverOnly: true });
    await invoke(a);
    await invoke(b);
    await b.flush();
    expect(calls()).toBe(2);
    expect(ingest.batches).toHaveLength(1);
  });

  it("250 queued events go out in three batches within one flush()", async () => {
    const analytics = createYavio({
      apiKey: "yav_f2",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    ingest.respondAfterMs = 30;
    for (let i = 0; i < 250; i++) await invoke(analytics); // the 100th and 200th send early
    await analytics.flush();
    expect(calls()).toBe(250);
    expect(ingest.responded).toBe(ingest.batches.length);
    expect(ingest.batches.length).toBeGreaterThanOrEqual(3);
  });

  it("a hanging ingest: resolves at flushTimeoutMs with one YAVIO-1208 line; nothing is dropped, the stale fetch is re-sent, and the backlog goes out once ingest answers", async () => {
    const analytics = createYavio({
      apiKey: "yav_f3",
      endpoint: ingest.endpoint,
      serverOnly: true,
      flushTimeoutMs: 300,
    });
    ingest.hangEvents = true;
    await invoke(analytics);
    const t0 = Date.now();
    await analytics.flush();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(Date.now() - t0).toBeLessThan(600);
    expect(flushLines()).toHaveLength(1);
    expect(flushLines()[0]).toMatch(
      /^\[YAVIO-1208\] flush\(\) left 2 events undelivered — ingest did not answer within 300 ms\. They stay queued/,
    );
    await invoke(analytics);
    await sleep(100);
    await analytics.flush(); // the fetch is 400 ms old: re-sent as it was, still hanging
    expect(flushLines()).toHaveLength(1); // once per stall
    expect(ingest.batches).toHaveLength(2);
    expect(ingest.batches[1]?.events.map((e) => e.event_id)).toEqual(
      ingest.batches[0]?.events.map((e) => e.event_id),
    );
    ingest.hangEvents = false;
    await sleep(100);
    await analytics.flush(); // ingest answers: the resend again, then the rest
    const ids = ingest.ofType("tool_call").map((e) => e.event_id);
    expect(new Set(ids).size).toBe(2); // both delivered (re-sends are ingest's to dedup)
    expect(flushLines()).toHaveLength(1);
    // A new stall after a flush that delivered everything is a new line.
    ingest.hangEvents = true;
    await invoke(analytics);
    await analytics.flush();
    expect(flushLines()).toHaveLength(2);
  });

  it("a refusing ingest costs two fast attempts, not the deadline: a retry that would end past it is not waited for", async () => {
    const analytics = createYavio({
      apiKey: "yav_f4",
      endpoint: await refusedEndpoint(),
      serverOnly: true,
    });
    await invoke(analytics);
    const t0 = Date.now();
    await analytics.flush();
    expect(Date.now() - t0).toBeLessThan(500); // not 1 s: the 1 s backoff ends past the deadline
    const t1 = Date.now();
    await analytics.flush(); // one more attempt, as fast
    expect(Date.now() - t1).toBeLessThan(500);
    expect(flushLines()).toHaveLength(1);
    expect(flushLines()[0]).toMatch(
      /flush\(\) left 2 events undelivered — ingest failed a batch, which waits for its retry/,
    );
    expect(lines().filter((l) => l.includes("YAVIO-1200"))).toHaveLength(1); // the early retries print none
  });

  it("a batch waiting for its retry is retried at once, once per flush(), without spending the retry budget", async () => {
    const analytics = createYavio({
      apiKey: "yav_f5",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    ingest.failNext = [503, 503];
    await invoke(analytics);
    const t0 = Date.now();
    await analytics.flush(); // 503, retried at once, 503: the retry waits 1 s, past the deadline
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ingest.batches.map((b) => b.status)).toEqual([503, 503]);
    const t1 = Date.now();
    await analytics.flush(); // retried now
    expect(Date.now() - t1).toBeLessThan(500);
    expect(ingest.batches.map((b) => b.status)).toEqual([503, 503, 200]);
    expect(flushLines()).toHaveLength(1);
  });

  it("concurrent flush() calls send each event once", async () => {
    const analytics = createYavio({
      apiKey: "yav_f6",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    ingest.respondAfterMs = 50;
    for (let i = 0; i < 20; i++) await invoke(analytics);
    await Promise.all(Array.from({ length: 10 }, () => analytics.flush()));
    const ids = ingest.ofType("tool_call").map((e) => e.event_id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("after shutdown(): a later wrap() holds the transport again and flush() delivers what it queued", async () => {
    const analytics = createYavio({
      apiKey: "yav_f7",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    await invoke(analytics);
    await analytics.shutdown();
    expect(calls()).toBe(1);
    await analytics.flush(); // nothing live: resolves at once
    await invoke(analytics);
    await analytics.flush();
    expect(calls()).toBe(2);
  });

  it("during a signal cycle: resolves by the process deadline, not by flushTimeoutMs, and prints no YAVIO-1208 (the cycle's line counts)", async () => {
    _setSignalReraise(() => {});
    const analytics = createYavio({
      apiKey: "yav_f8",
      endpoint: ingest.endpoint,
      serverOnly: true,
      shutdownTimeoutMs: 300,
      flushTimeoutMs: 5_000,
    });
    ingest.hangEvents = true;
    await invoke(analytics);
    const t0 = Date.now();
    emitAlone("SIGTERM");
    await analytics.flush();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(flushLines()).toEqual([]);
  });

  it("no-op mode: flush() resolves at once", async () => {
    const analytics = createYavio({ apiKey: "" });
    await expect(analytics.flush()).resolves.toBeUndefined();
  });

  it("flushTimeoutMs takes [100, 2147483647] from the option, YAVIO_FLUSH_TIMEOUT_MS or .yaviorc.json; anything else is one YAVIO-1006 and the 1 s default", async () => {
    _resetConfigWarnings();
    createYavio({ apiKey: "yav_f9", endpoint: ingest.endpoint, flushTimeoutMs: 5 });
    createYavio({ apiKey: "yav_f9", endpoint: ingest.endpoint, flushTimeoutMs: 1.5 });
    const invalid = lines().filter((l) => l.includes("YAVIO-1006") && l.includes("flushTimeoutMs"));
    expect(invalid).toEqual([
      "[YAVIO-1006] flushTimeoutMs must be an integer between 100 and 2147483647 milliseconds, got 5 — using 1000. Shown once per process.",
    ]);
  });
});

describe("flushWhenSent() (#171)", () => {
  /** A v2 server whose tool takes `ms`: a streamed response's fetch() resolves before it ends. */
  function slowServer(analytics: ReturnType<typeof createYavio>, ms: number) {
    const server = new McpServerV2({ name: "fn", version: "1.0" });
    server.registerTool(
      "slow",
      { description: "Takes a while", inputSchema: { q: z.string() } },
      async ({ q }: { q: string }) => {
        await sleep(ms);
        return { content: [{ type: "text" as const, text: q }] };
      },
    );
    return analytics.wrap(server);
  }

  /** A 2025-era tools/call, as most clients send it today: answered with Server-Sent Events. */
  const toolsCall = () =>
    new Request("http://fn.local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "slow", arguments: { q: "x" }, _meta: { "openai/session": "conv-1" } },
      }),
    });

  it("MCP SDK v2 createMcpHandler, a streamed response and a 300 ms tool: the call's event is at ingest when the waitUntil promise settles — where a flush right after fetch() resolves before the call has ended", async () => {
    const analytics = createYavio({
      apiKey: "yav_s1",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const mcp = createMcpHandler(() => slowServer(analytics, 300));

    // The naive placement: waitUntil(analytics.flush()) right after fetch().
    const early = await mcp.fetch(toolsCall());
    expect(early.headers.get("content-type")).toContain("text/event-stream");
    await analytics.flush();
    expect(calls()).toBe(0); // the tool is still running: its event does not exist yet
    await early.text();
    await analytics.flush(); // what the next invocation's flush would carry
    expect(calls()).toBe(1);

    // flushWhenSent: the platform reads the body to its end, then the flush runs.
    let waited: Promise<unknown> | undefined;
    const response = analytics.flushWhenSent(await mcp.fetch(toolsCall()), (promise) => {
      waited = promise;
    });
    const body = await response.text();
    expect(body).toContain('"result"');
    await waited;
    expect(calls()).toBe(2);
  });

  it("keeps status, status text, headers and the body", async () => {
    const analytics = createYavio({
      apiKey: "yav_s2",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const original = new Response("event: message\ndata: {}\n\n", {
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1", "x-extra": "1" },
    });
    const headers = [...original.headers];
    let waited: Promise<unknown> | undefined;
    const response = analytics.flushWhenSent(original, (promise) => {
      waited = promise;
    });
    expect(response).not.toBe(original);
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted");
    expect([...response.headers]).toEqual(headers);
    expect(await response.text()).toBe("event: message\ndata: {}\n\n");
    await expect(waited).resolves.toBeUndefined();
  });

  it("a body the client cancels (it went away) still flushes", async () => {
    const analytics = createYavio({
      apiKey: "yav_s3",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    await invoke(analytics);
    const endless = new ReadableStream({
      pull: async () => {
        await sleep(1_000);
      },
    });
    let waited: Promise<unknown> | undefined;
    const response = analytics.flushWhenSent(new Response(endless), (promise) => {
      waited = promise;
    });
    await response.body?.cancel();
    await waited;
    expect(calls()).toBe(1);
  });

  it("a response without a body comes back as it is and flushes at once", async () => {
    const analytics = createYavio({
      apiKey: "yav_s4",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    await invoke(analytics);
    const original = new Response(null, { status: 202 });
    let waited: Promise<unknown> | undefined;
    const response = analytics.flushWhenSent(original, (promise) => {
      waited = promise;
    });
    expect(response).toBe(original);
    await waited;
    expect(calls()).toBe(1);
  });

  it("a context is called as its method — workerd throws Illegal invocation for a ctx.waitUntil called on its own", async () => {
    const analytics = createYavio({
      apiKey: "yav_s5",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    await invoke(analytics);
    let self: unknown;
    let waited: Promise<unknown> | undefined;
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        self = this;
        waited = promise;
      },
    };
    const response = analytics.flushWhenSent(new Response("x"), ctx);
    expect(await response.text()).toBe("x");
    await waited;
    expect(self).toBe(ctx);
    expect(calls()).toBe(1);
  });

  it("a waitUntil that throws: the response still comes back, the flush still runs, one line", async () => {
    const analytics = createYavio({
      apiKey: "yav_s6",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    await invoke(analytics);
    const unbound = () => {
      throw new TypeError("Illegal invocation");
    };
    const response = analytics.flushWhenSent(new Response("x"), unbound);
    analytics.flushWhenSent(new Response("y"), unbound);
    expect(await response.text()).toBe("x");
    await vi.waitFor(() => expect(calls()).toBe(1));
    const thrown = error.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("flushWhenSent"));
    expect(thrown).toEqual([
      "[yavio] flushWhenSent(): waitUntil threw (Illegal invocation) — the flush runs without it, and the platform may freeze it before it ends. Pass the context itself (flushWhenSent(response, ctx)) or a bound function. Shown once per process.",
    ]);
  });

  it("no-op mode: the response comes back untouched and waitUntil is not called", () => {
    const analytics = createYavio({ apiKey: "" });
    const original = new Response("x");
    const waitUntil = vi.fn();
    expect(analytics.flushWhenSent(original, waitUntil)).toBe(original);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
