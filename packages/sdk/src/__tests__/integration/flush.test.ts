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
import { HttpTransport } from "../../transport/http.js";
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
    // A new stall after a flush that delivered everything is a new line —
    // but not within a minute of the last one (review round 4's backstop).
    ingest.hangEvents = true;
    await invoke(analytics);
    await analytics.flush();
    expect(flushLines()).toHaveLength(1);
    ingest.hangEvents = false;
    await sleep(100);
    await analytics.flush(); // delivers everything: the stall is over
    expect(new Set(ingest.ofType("tool_call").map((e) => e.event_id)).size).toBe(3);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000); // a minute later
    ingest.hangEvents = true;
    await invoke(analytics);
    await analytics.flush();
    expect(flushLines()).toHaveLength(2);
  });

  it("a refusing ingest: a flush never waits out a backoff that ends past its deadline, and retries early only once the last attempt is a second old", async () => {
    const analytics = createYavio({
      apiKey: "yav_f4",
      endpoint: await refusedEndpoint(),
      serverOnly: true,
    });
    await invoke(analytics);
    const t0 = Date.now();
    await analytics.flush();
    expect(Date.now() - t0).toBeLessThan(500); // not 1 s: the 1 s backoff ends past the deadline
    await sleep(1_100); // the backoff's own retry, refused: a 2 s backoff
    const t1 = Date.now();
    await analytics.flush(); // the last attempt is fresh: nothing sent
    expect(Date.now() - t1).toBeLessThan(500);
    await sleep(1_000);
    const t2 = Date.now();
    await analytics.flush(); // a second old: one early retry, refused, no line of its own
    expect(Date.now() - t2).toBeLessThan(500);
    expect(flushLines()).toHaveLength(1);
    expect(flushLines()[0]).toMatch(
      /flush\(\) left 2 events undelivered — ingest failed a batch, which waits for its retry/,
    );
    expect(lines().filter((l) => l.includes("YAVIO-1200"))).toEqual([
      "[YAVIO-1200] Network error, retry 1/5",
      "[YAVIO-1200] Network error, retry 2/5",
    ]);
  }, 10_000);

  it("a batch waiting for its retry is retried at once by a flush once its last attempt is a second old, instead of after its backoff", async () => {
    const analytics = createYavio({
      apiKey: "yav_f5",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    ingest.failNext = [503, 503];
    await invoke(analytics);
    const t0 = Date.now();
    await analytics.flush(); // 503: the 1 s backoff ends past the deadline
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ingest.batches.map((b) => b.status)).toEqual([503]);
    await sleep(2_100); // the backoff's retry at 1 s: 503, and a 2 s backoff, until 3 s
    expect(ingest.batches.map((b) => b.status)).toEqual([503, 503]);
    const t1 = Date.now();
    await analytics.flush(); // a second old: retried now, not at 3 s
    expect(Date.now() - t1).toBeLessThan(500);
    expect(ingest.batches.map((b) => b.status)).toEqual([503, 503, 200]);
    expect(flushLines()).toHaveLength(1);
  }, 10_000);

  it("a 503 ingest and a host that flushes after every request, one every 20 ms: about one early retry a second, not one per request (#171 review round 1)", async () => {
    ingest.failWith = 503;
    const analytics = createYavio({
      apiKey: "yav_storm",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const flushes: Promise<void>[] = [];
    const t0 = Date.now();
    let requests = 0;
    while (Date.now() - t0 < 3_000) {
      await invoke(analytics);
      requests++;
      flushes.push(analytics.flush());
      await sleep(20);
    }
    await Promise.all(flushes);
    expect(requests).toBeGreaterThan(50);
    // The first attempt, the backoff's retry at 1 s, early retries at about
    // 2 s and 3 s — on 0.5.6's first cut, one per request (130 in 3 s).
    expect(ingest.batches.length).toBeLessThanOrEqual(8);
  }, 20_000);

  it("an ingest that answers, only slower than flushTimeoutMs, and a host that flushes after every request: calls keep getting through — the head batch is not re-sent forever (#171 review round 1)", async () => {
    ingest.respondAfterMs = 600;
    const analytics = createYavio({
      apiKey: "yav_slow",
      endpoint: ingest.endpoint,
      serverOnly: true,
      flushTimeoutMs: 400,
    });
    const flushes: Promise<void>[] = [];
    const t0 = Date.now();
    let requests = 0;
    while (Date.now() - t0 < 3_000) {
      await invoke(analytics);
      requests++;
      flushes.push(analytics.flush());
      await sleep(100);
    }
    // What ingest has answered while the requests came: no batch it was
    // still answering when a flush aborted it counts.
    const answered = new Set(
      ingest.batches
        .filter((b) => b.status === 200 && b.abortedAt === undefined)
        .flatMap((b) => b.events.filter((e) => e.event_type === "tool_call"))
        .map((e) => e.event_id),
    );
    expect(answered.size).toBeGreaterThanOrEqual(Math.floor(requests / 2));
    await Promise.all(flushes);
  }, 20_000);

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

  it("a flush() during the last holder's shutdown() waits for that stop (decision J)", async () => {
    ingest.respondAfterMs = 200;
    const analytics = createYavio({
      apiKey: "yav_j",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    await invoke(analytics);
    const closing = analytics.shutdown(); // the last hold: the transport stops, its batch on its way
    await analytics.flush();
    expect(ingest.responded).toBe(1);
    await closing;
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

  it("waitUntilTimeoutMs takes the same range; anything else is one YAVIO-1006 and the 10 s default (#171 review round 2)", async () => {
    _resetConfigWarnings();
    createYavio({ apiKey: "yav_f10", endpoint: ingest.endpoint, waitUntilTimeoutMs: 0 });
    const invalid = lines().filter(
      (l) => l.includes("YAVIO-1006") && l.includes("waitUntilTimeoutMs"),
    );
    expect(invalid).toEqual([
      "[YAVIO-1006] waitUntilTimeoutMs must be an integer between 100 and 2147483647 milliseconds, got 0 — using 10000. Shown once per process.",
    ]);
  });

  /**
   * A busy host and a healthy ingest (#171 review round 4, the reviewer's
   * review-steady): a request every few milliseconds, each flushing. Before,
   * a flush chased every event queued after its call until its budget ran
   * out, so every flush took 1 s and printed `YAVIO-1208` while ingest
   * answered in 50 ms. A flush's job is what was queued or in flight at its
   * call: it ends after a round trip or two.
   */
  it.each([
    ["flushWhenSent(), a request every 20 ms", "sent", 20],
    ["flushWhenSent(), a request every 5 ms", "sent", 5],
    ["flush(), a request every 20 ms", "plain", 20],
  ])(
    "steady traffic against a healthy ingest (%s): every flush ends within a round trip or two, nothing undelivered, no YAVIO-1208 line (#171 review round 4)",
    async (_label, how, gap) => {
      ingest.respondAfterMs = 50;
      const analytics = createYavio({
        apiKey: `yav_steady_${how}_${gap}`,
        endpoint: ingest.endpoint,
        serverOnly: true,
      });
      const durations: number[] = [];
      const all: Promise<unknown>[] = [];
      let requests = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 2_000) {
        await invoke(analytics);
        requests++;
        const started = Date.now();
        const done = () => durations.push(Date.now() - started);
        if (how === "sent") {
          await analytics
            .flushWhenSent(new Response("x"), (promise) => {
              all.push(promise.then(done));
            })
            .text();
        } else {
          all.push(analytics.flush().then(done));
        }
        await sleep(gap);
      }
      await Promise.all(all);
      durations.sort((a, b) => a - b);
      const p50 = durations[Math.floor(durations.length / 2)] ?? Number.NaN;
      expect(new Set(ingest.ofType("tool_call").map((e) => e.event_id)).size).toBe(requests);
      expect(flushLines()).toEqual([]);
      expect(p50).toBeLessThan(400); // a round trip or two of 50 ms, not the 1 s budget
    },
    30_000,
  );

  it("steady traffic against a hanging ingest: the stall is still one YAVIO-1208 line, from the flush whose own batch went unanswered, though the others defer to it (#171 review round 4)", async () => {
    ingest.hangEvents = true;
    const analytics = createYavio({
      apiKey: "yav_steady_hang",
      endpoint: ingest.endpoint,
      serverOnly: true,
      flushTimeoutMs: 300,
    });
    const all: Promise<unknown>[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1_500) {
      await invoke(analytics);
      all.push(analytics.flush());
      await sleep(20);
    }
    await Promise.all(all);
    expect(flushLines()).toHaveLength(1);
    expect(flushLines()[0]).toMatch(/ingest did not answer within 300 ms/);
  }, 15_000);
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

  /**
   * Cloudflare Workers' rule, emulated (#171 review round 2): a fetch
   * belongs to its request, and the request ends once what `waitUntil`
   * holds has settled — an answer that arrives after that is never seen.
   * Here ingest answers in 1.5 s, slower than `flushTimeoutMs`.
   */
  function workersFetch(answerAfterMs: number) {
    const state = { alive: true, answered: 0, calls: 0 };
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          state.calls++;
          setTimeout(() => {
            if (!state.alive) return; // the request has ended: no answer, ever
            state.answered++;
            resolve(new Response("{}", { status: 200 }));
          }, answerAfterMs);
        }),
    );
    return { fetch, state };
  }

  it("on Workers, against an ingest slower than flushTimeoutMs: flushWhenSent's flush keeps waiting for the batch it sent, within waitUntilTimeoutMs, so it is answered before the request ends (#171 review round 2)", async () => {
    const { fetch, state } = workersFetch(1_500);
    vi.stubGlobal("fetch", fetch);
    try {
      const analytics = createYavio({
        apiKey: "yav_wu1",
        endpoint: "http://ingest.test/v1/events",
        serverOnly: true,
      });
      await invoke(analytics);
      let held: Promise<unknown> | undefined;
      const t0 = Date.now();
      const response = analytics.flushWhenSent(new Response("x"), (promise) => {
        held = promise;
      });
      expect(await response.text()).toBe("x"); // the response is not held up
      await held;
      state.alive = false; // what waitUntil held has settled: the request ends
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(state.answered).toBe(1);
      expect(flushLines()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("plain flush() keeps flushTimeoutMs: it does not wait past it for the batch it sent (#171 review round 2)", async () => {
    const { fetch, state } = workersFetch(1_500);
    vi.stubGlobal("fetch", fetch);
    try {
      const analytics = createYavio({
        apiKey: "yav_wu2",
        endpoint: "http://ingest.test/v1/events",
        serverOnly: true,
      });
      await invoke(analytics);
      const t0 = Date.now();
      await analytics.flush();
      state.alive = false;
      expect(Date.now() - t0).toBeLessThan(1_400);
      expect(state.answered).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("on Workers, a burst against an ingest slower than flushTimeoutMs: every event is answered, and the concurrent request's flush, deferred to the holder, prints no YAVIO-1208 line (#171 review round 4)", async () => {
    const { fetch, state } = workersFetch(1_500);
    vi.stubGlobal("fetch", fetch);
    try {
      const analytics = createYavio({
        apiKey: "yav_burst",
        endpoint: "http://ingest.test/v1/events",
        serverOnly: true,
      });
      const held: Promise<unknown>[] = [];
      for (let request = 0; request < 2; request++) {
        await invoke(analytics);
        await analytics
          .flushWhenSent(new Response("x"), (promise) => {
            held.push(promise);
          })
          .text();
        await sleep(200);
      }
      await Promise.all(held);
      state.alive = false;
      expect(state.calls).toBe(2); // the holder's batch, then the other request's event
      expect(state.answered).toBe(2);
      expect(flushLines()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("waitUntilTimeoutMs bounds that wait: a hanging ingest holds the waitUntil promise no longer, and the batch stays queued", async () => {
    const { fetch, state } = workersFetch(60_000);
    vi.stubGlobal("fetch", fetch);
    try {
      const analytics = createYavio({
        apiKey: "yav_wu3",
        endpoint: "http://ingest.test/v1/events",
        serverOnly: true,
        waitUntilTimeoutMs: 1_500,
      });
      await invoke(analytics);
      let held: Promise<unknown> | undefined;
      const t0 = Date.now();
      await analytics
        .flushWhenSent(new Response("x"), (promise) => {
          held = promise;
        })
        .text();
      await held;
      state.alive = false;
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(state.calls).toBe(1);
      expect(flushLines()).toHaveLength(1); // the stall, once
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  /**
   * The transport's own flush must have ended — its watches removed from
   * its own context — before what `waitUntil` holds settles: on Workers the
   * request ends then, and a timer of the transport's still pending never
   * fires (#171 review round 3: the outer deadline in `flushShared()` and
   * the hold's own timer came due in the same millisecond, the outer one
   * won, and a watch was left behind, which a later request's flush then
   * resolved: workerd's "different request context" warning).
   */
  it.each([
    ["the hold runs into waitUntilTimeoutMs", "sent"],
    ["a plain flush() runs into flushTimeoutMs", "plain"],
  ])(
    "when %s, the transport's flush has ended before the promise waitUntil holds settles (#171 review round 3)",
    async (_label, how) => {
      const { fetch, state } = workersFetch(60_000);
      vi.stubGlobal("fetch", fetch);
      const original = HttpTransport.prototype.flushQueued;
      const inner: boolean[] = [];
      vi.spyOn(HttpTransport.prototype, "flushQueued").mockImplementation(function (
        this: HttpTransport,
        ...args: Parameters<HttpTransport["flushQueued"]>
      ) {
        const index = inner.push(false) - 1;
        const flushing = original.apply(this, args);
        void flushing.then(() => {
          inner[index] = true;
        });
        return flushing;
      });
      try {
        const analytics = createYavio({
          apiKey: `yav_race_${how}`,
          endpoint: "http://ingest.test/v1/events",
          serverOnly: true,
          waitUntilTimeoutMs: 1_500,
        });
        await invoke(analytics);
        // Timers that come due in the same millisecond fire in the order they
        // were set, as on workerd — Node's own order there differs by run.
        vi.useFakeTimers();
        let atSettle: boolean[] | undefined;
        const settled = (): void => {
          atSettle = [...inner];
        };
        if (how === "sent") {
          await analytics
            .flushWhenSent(new Response("x"), (promise) => {
              void promise.then(settled);
            })
            .text();
        } else {
          void analytics.flush().then(settled);
        }
        await vi.advanceTimersByTimeAsync(2_000);
        state.alive = false;
        expect(atSettle).toEqual([true]);
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
    15_000,
  );
});
