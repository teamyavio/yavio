import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ABORT_SETTLE_MS,
  HttpTransport,
  MAX_RETRY_AFTER_MS,
  retryAfterMs,
} from "../transport/http.js";

function createMockFetch(status = 200, body = {}, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    status,
    headers: {
      get: (name: string) => headers?.[name] ?? null,
    },
    json: () => Promise.resolve(body),
  });
}

function fakeEvent(overrides: Partial<BaseEvent> = {}): BaseEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "track",
    trace_id: "tr_test",
    session_id: "ses_test",
    timestamp: new Date().toISOString(),
    source: "server",
    ...overrides,
  } as BaseEvent;
}

describe("HttpTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers events without sending immediately", () => {
    const fetch = createMockFetch();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetch,
    });
    transport.send([fakeEvent()]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends events on flush with correct headers and body", async () => {
    const fetch = createMockFetch();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetch,
    });
    transport.send([fakeEvent()]);
    await transport.flush();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test/v1/events");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer yav_test",
    });
    const body = JSON.parse(options.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.sdk_version).toBe("0.0.1");
    expect(body.sent_at).toBeDefined();
  });

  it("does not send when buffer is empty", async () => {
    const fetch = createMockFetch();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetch,
    });
    await transport.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("triggers early flush when batch size is reached", async () => {
    const fetch = createMockFetch();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBatchSize: 5,
      fetch,
    });
    const events = Array.from({ length: 5 }, () => fakeEvent());
    transport.send(events);
    // Early flush is async — let microtasks resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("flushes periodically via timer", async () => {
    const fetch = createMockFetch();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      flushIntervalMs: 1000,
      fetch,
    });
    transport.start();
    transport.send([fakeEvent()]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("drops oldest events when buffer overflows", () => {
    const fetch = createMockFetch();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBufferSize: 5,
      maxBatchSize: 100, // Prevent early flush
      fetch,
    });
    const events = Array.from({ length: 8 }, (_, i) => fakeEvent({ event_name: `event_${i}` }));
    transport.send(events);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Dropped 3 oldest events"));
    warnSpy.mockRestore();
  });

  it("retries on 5xx with exponential backoff", async () => {
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve({ status: 500, headers: { get: () => null }, json: () => ({}) });
      }
      return Promise.resolve({ status: 200, headers: { get: () => null }, json: () => ({}) });
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxRetries: 3,
      fetch,
    });
    transport.send([fakeEvent()]);
    const flushPromise = transport.flush();

    // Advance through retry delays: 1s, 2s
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromise;

    expect(fetch).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("stops permanently on 401", async () => {
    const fetch = createMockFetch(401);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_bad_key",
      sdkVersion: "0.0.1",
      fetch,
    });
    transport.send([fakeEvent()]);
    await transport.flush();

    // After 401, further sends should be ignored
    transport.send([fakeEvent()]);
    await transport.flush();
    expect(fetch).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
  });

  it("a 401 outside a shutdown stops the flush timer and reports the transport closed once — a later shutdown() does not report it again", async () => {
    const fetch = createMockFetch(401);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onClosed = vi.fn();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_bad_key",
      sdkVersion: "0.0.1",
      flushIntervalMs: 10_000,
      fetch,
      onClosed,
    });
    transport.start();
    expect(vi.getTimerCount()).toBe(0); // armed on the first send (#171)
    transport.send([fakeEvent()]);
    expect(vi.getTimerCount()).toBe(1); // the flush interval
    await transport.flush();
    // Before #148 review round 5 the 401 only set `stopped`: the interval
    // kept ticking into a dead transport every 10 s and `onClosed` never
    // ran, so the registry kept the transport for the process lifetime.
    expect(vi.getTimerCount()).toBe(0);
    expect(onClosed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledOnce();

    await transport.shutdown();
    expect(onClosed).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("respects Retry-After header on 429 (value in seconds per HTTP spec)", async () => {
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 429,
          // Retry-After header is in seconds per HTTP spec
          headers: { get: (name: string) => (name === "Retry-After" ? "2" : null) },
          json: () => ({}),
        });
      }
      return Promise.resolve({ status: 200, headers: { get: () => null }, json: () => ({}) });
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetch,
    });
    transport.send([fakeEvent()]);
    const flushPromise = transport.flush();

    // 2 seconds in the header → 2000ms delay
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromise;

    expect(fetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("handles 207 partial rejection", async () => {
    const fetch = createMockFetch(207, { rejected: 2, errors: [] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetch,
    });
    transport.send([fakeEvent()]);
    await transport.flush();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("2 events rejected"));
    warnSpy.mockRestore();
  });

  it("flushes all remaining events on shutdown", async () => {
    const fetch = createMockFetch();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBatchSize: 3,
      fetch,
    });
    transport.start();
    transport.send(Array.from({ length: 7 }, () => fakeEvent()));
    await transport.shutdown();

    // 7 events with batch size 3 = 3 batches (3 + 3 + 1)
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shutdown continues flushing remaining batches after a batch error", async () => {
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Network failure"));
      }
      return Promise.resolve({ status: 200, headers: { get: () => null }, json: () => ({}) });
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBatchSize: 2,
      maxRetries: 0, // No retries — fail immediately
      fetch,
    });
    // 4 events → 2 batches of 2
    transport.send(Array.from({ length: 4 }, () => fakeEvent()));
    await transport.shutdown();

    // Both batches attempted despite first one failing
    expect(fetch).toHaveBeenCalledTimes(2);
    // The failed batch is a delivery failure (its YAVIO-1201 line), not a
    // loss of the shutdown deadline, which was never reached: before #148
    // review round 2 the shutdown reported it as "deadline of 4000 ms
    // reached — 2 events not delivered".
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("YAVIO-1201"));
    expect(warnSpy.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining("1205"),
    );
    expect(transport.lostEvents()).toBe(2);
    expect(transport.deadlineLostEvents()).toBe(0);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("retries on network errors", async () => {
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Network failure"));
      }
      return Promise.resolve({ status: 200, headers: { get: () => null }, json: () => ({}) });
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxRetries: 2,
      fetch,
    });
    transport.send([fakeEvent()]);
    const flushPromise = transport.flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromise;

    expect(fetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("aborts fetch after timeout", async () => {
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetchTimeoutMs: 500,
      maxRetries: 0,
      fetch,
    });
    transport.send([fakeEvent()]);
    const flushPromise = transport.flush();

    await vi.advanceTimersByTimeAsync(500);
    await flushPromise;

    expect(fetch).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("passes abort signal to fetch", async () => {
    const fetch = createMockFetch();
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      fetch,
    });
    transport.send([fakeEvent()]);
    await transport.flush();

    const [, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("drops remaining events when shutdown timeout is reached", async () => {
    // Never answers; rejects once the deadline aborts it, as a real fetch does.
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      shutdownTimeoutMs: 1000,
      maxBatchSize: 100,
      fetch,
    });
    transport.send(Array.from({ length: 5 }, () => fakeEvent()));
    const shutdownPromise = transport.shutdown();

    await vi.advanceTimersByTimeAsync(1000);
    await shutdownPromise;

    // One YAVIO-1205 line with the count and the deadline (#148).
    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("1205"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("deadline of 1000 ms");
    expect(lines[0]).toContain("5 events not delivered");
    expect(transport.lostEvents()).toBe(5);
    warnSpy.mockRestore();
  });
});

describe("HttpTransport.shutdown() and a send in flight", () => {
  it("waits for the batch in flight before resolving, without sending it twice", async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, headers: { get: () => null }, json: () => ({}) });
        }),
    );
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      flushIntervalMs: 60_000,
      shutdownTimeoutMs: 5_000,
      fetch,
    });
    transport.send([fakeEvent()]);
    const flushing = transport.flush(); // in flight, blocked on fetch
    let done = false;
    const shutdown = transport.shutdown().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    release?.();
    await Promise.all([flushing, shutdown]);
    expect(done).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport.drain()", () => {
  it("delivers every queued batch without stopping, waiting for a send already in flight", async () => {
    const batches: number[] = [];
    let release: (() => void) | undefined;
    const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const count = (JSON.parse(init.body as string).events as unknown[]).length;
      // The first batch hangs until the test releases it — a timer flush in flight.
      if (batches.length === 0)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      batches.push(count);
      return { status: 200, headers: { get: () => null }, json: () => ({}) };
    });
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBatchSize: 100,
      flushIntervalMs: 60_000,
      fetch,
    });
    transport.start();
    for (let i = 0; i < 250; i++) transport.send([fakeEvent()]);
    // The early flush at 100 is in flight and blocked; flush() alone returns at once.
    expect(fetch).toHaveBeenCalledTimes(1);
    await transport.flush();
    expect(batches).toEqual([]);

    const drained = transport.drain();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release?.();
    await drained;

    expect(batches).toEqual([100, 100, 50]);
    // Not stopped: later events still go out.
    transport.send([fakeEvent()]);
    await transport.flush();
    expect(batches).toEqual([100, 100, 50, 1]);
    await transport.shutdown();
  });

  it("gives up at shutdownTimeoutMs against a hanging endpoint, keeps the queue and stays live", async () => {
    const okResponse = { status: 200, headers: { get: () => null }, json: () => ({}) };
    let hanging = true;
    const pending: Array<() => void> = [];
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          if (!hanging) resolve(okResponse);
          else pending.push(() => resolve(okResponse));
        }),
    );
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      fetchTimeoutMs: 60_000,
      shutdownTimeoutMs: 50,
      fetch,
    });
    for (let i = 0; i < 6; i++) transport.send([fakeEvent()]);
    const started = Date.now();
    await transport.drain();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetch).toHaveBeenCalledTimes(1); // the first batch, still hanging

    // Not stopped and nothing dropped: once ingest answers, the queue goes out.
    hanging = false;
    for (const release of pending) release();
    await transport.drain();
    let delivered = 0;
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit]>) {
      delivered += (JSON.parse(init.body as string).events as unknown[]).length;
    }
    expect(delivered).toBe(6);
    transport.send([fakeEvent()]);
    await transport.flush();
    expect(fetch).toHaveBeenCalledTimes(4);
    await transport.shutdown();
  });

  it("is bounded: a batch that keeps failing does not loop forever", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("down"));
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      maxBatchSize: 2,
      maxBufferSize: 6,
      maxRetries: 0,
      flushIntervalMs: 60_000,
      fetch,
    });
    for (let i = 0; i < 6; i++) transport.send([fakeEvent()]);
    await expect(transport.drain()).resolves.toBeUndefined();
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(6 / 2 + 1);
  });
});

describe("HttpTransport.shutdown() is idempotent (#142)", () => {
  /** A fetch that answers after a real delay; `settled()` counts the fetches answered so far. */
  function slowFetch(delayMs: number) {
    let settled = 0;
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled++;
            resolve({ status: 200, headers: { get: () => null }, json: () => ({}) });
          }, delayMs),
        ),
    );
    return { fetch, settled: () => settled };
  }

  it("a second shutdown() resolves with the first, after the same send, without sending twice", async () => {
    const { fetch, settled } = slowFetch(100);
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      flushIntervalMs: 60_000,
      fetch,
    });
    transport.start();
    transport.send([fakeEvent()]);
    const first = transport.shutdown().then(() => settled());
    const second = transport.shutdown().then(() => settled());
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drain() after shutdown() waits for the shutdown's sends", async () => {
    const { fetch, settled } = slowFetch(100);
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      flushIntervalMs: 60_000,
      fetch,
    });
    transport.start();
    transport.send([fakeEvent()]);
    const closing = transport.shutdown();
    await transport.drain();
    expect(settled()).toBe(1);
    await closing;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a drain() that started before shutdown() waits for the shutdown's sends too", async () => {
    const { fetch, settled } = slowFetch(100);
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
      flushIntervalMs: 60_000,
      maxBatchSize: 1,
      fetch,
    });
    transport.start();
    transport.send([fakeEvent(), fakeEvent()]);
    const draining = transport.drain(); // first batch out, second queued
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = transport.shutdown(); // takes over the second batch
    await draining;
    // Both batches answered when drain() resolves — not just the first,
    // with the second still on its way out under the shutdown.
    expect(settled()).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    await closing;
  });
});

/**
 * The deadline stops the waiting, not only the awaiting (#148, Decision B):
 * at a transport's shutdown deadline the fetch in flight is aborted, no
 * backoff or `Retry-After` wait that would end at or after the deadline is
 * scheduled, `Retry-After` is read as delay-seconds or an HTTP-date, and
 * every timer is unref'd. Before #148 the retry loop never looked at the
 * deadline: a host without `process.exit()` stayed alive for 31 s against a
 * refusing ingest and re-sent its batch at 31 s against a hanging one.
 */
describe("HttpTransport and the shutdown deadline (#148)", () => {
  const ok = { status: 200, headers: { get: () => null }, json: () => ({}) };
  const base = { endpoint: "http://test/v1/events", apiKey: "yav_test", sdkVersion: "0.0.1" };

  /** A fetch that never answers on its own and rejects when its signal is aborted. */
  function abortableFetch() {
    let aborted = 0;
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted++;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    return { fetch, aborted: () => aborted };
  }

  describe("with fake timers", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    let error: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      error = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
      error.mockRestore();
      vi.useRealTimers();
    });

    it("aborts the fetch in flight at the shutdown deadline and schedules no retry after it", async () => {
      const { fetch, aborted } = abortableFetch();
      const transport = new HttpTransport({
        ...base,
        shutdownTimeoutMs: 500,
        fetchTimeoutMs: 60_000,
        maxRetries: 3,
        fetch,
      });
      transport.send([fakeEvent()]);
      const shutdown = transport.shutdown();
      await vi.advanceTimersByTimeAsync(500);
      await shutdown;
      expect(aborted()).toBe(1);
      // The abort is a network error to the retry loop; its 1 s backoff
      // would end after the deadline, so the batch is given up.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(transport.pendingEvents()).toBe(0);
    });

    it("schedules no backoff wait that would end at or after the deadline", async () => {
      const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const transport = new HttpTransport({
        ...base,
        shutdownTimeoutMs: 1_500,
        maxRetries: 5,
        fetch,
      });
      transport.send([fakeEvent()]);
      const shutdown = transport.shutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdown;
      // Attempts at 0 and 1 s; the 2 s wait after the second would end at
      // 3 s, past the 1.5 s deadline, so it is not scheduled (before #148:
      // attempts at 0, 1, 3 and 7 s, the process kept alive by each wait).
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("cuts a backoff sleep already running when the deadline arrives: no send after it, the loss counted once", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue({ status: 503, headers: { get: () => null }, json: () => ({}) });
      const losses: Array<[number, number]> = [];
      const transport = new HttpTransport({
        ...base,
        maxRetries: 5,
        fetch,
        onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
      });
      transport.send([fakeEvent()]);
      const flushing = transport.flush();
      // 503 at 0, 1, 3 and 7 s; the fourth schedules an 8 s backoff (ends at 15 s).
      await vi.advanceTimersByTimeAsync(7_050);
      expect(fetch).toHaveBeenCalledTimes(4);

      // shutdown() with a 1 s deadline during that sleep: before the fix
      // the deadline counted the batch as lost and reported it, then the
      // sleep ran on and the batch was sent a fifth time at 15 s.
      const shutdown = transport.shutdown(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await shutdown;
      expect(transport.lostEvents()).toBe(1);
      expect(losses).toEqual([[1, 1_000]]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetch).toHaveBeenCalledTimes(4); // nothing sent after the deadline
      await flushing; // the retry loop woke at the deadline and gave up
      expect(transport.lostEvents()).toBe(1);
      expect(transport.pendingEvents()).toBe(0);
    });

    it("cuts a Retry-After sleep the same way", async () => {
      const fetch = vi.fn().mockResolvedValue({
        status: 429,
        headers: { get: (name: string) => (name === "Retry-After" ? "20" : null) },
        json: () => ({}),
      });
      const transport = new HttpTransport({ ...base, maxRetries: 3, fetch });
      transport.send([fakeEvent()]);
      const flushing = transport.flush();
      await vi.advanceTimersByTimeAsync(50); // the 20 s wait is scheduled
      const shutdown = transport.shutdown(500);
      await vi.advanceTimersByTimeAsync(500);
      await shutdown;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      await flushing;
      expect(transport.lostEvents()).toBe(1);
    });

    it("honours Retry-After as an HTTP-date", async () => {
      let calls = 0;
      const fetch = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          const at = new Date(Date.now() + 3_000).toUTCString();
          return Promise.resolve({
            status: 429,
            headers: { get: (name: string) => (name === "Retry-After" ? at : null) },
            json: () => ({}),
          });
        }
        return Promise.resolve(ok);
      });
      const transport = new HttpTransport({ ...base, fetch });
      transport.send([fakeEvent()]);
      const flushing = transport.flush();
      await vi.advanceTimersByTimeAsync(2_900);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      await flushing;
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("caps a Retry-After wait at the shutdown deadline: one that ends after it is not scheduled", async () => {
      let calls = 0;
      const fetch = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            status: 429,
            headers: { get: (name: string) => (name === "Retry-After" ? "5" : null) },
            json: () => ({}),
          });
        }
        return Promise.resolve(ok);
      });
      const transport = new HttpTransport({ ...base, shutdownTimeoutMs: 1_000, fetch });
      transport.send([fakeEvent()]);
      const shutdown = transport.shutdown();
      await vi.advanceTimersByTimeAsync(1_000);
      await shutdown;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("a 429 on the last allowed attempt is given up: counted lost, one 1201 line, no sleep", async () => {
      const fetch = vi.fn().mockResolvedValue({
        status: 429,
        headers: { get: (name: string) => (name === "Retry-After" ? "5" : null) },
        json: () => ({}),
      });
      // A post-signal transport: one attempt. Before the fix the 429 branch
      // had no last-attempt guard: it logged "retrying in 5000ms", slept the
      // full Retry-After, left the loop and dropped the batch uncounted.
      const transport = new HttpTransport({ ...base, maxRetries: 0, fetch });
      transport.send([fakeEvent()]);
      const flushing = transport.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.lostEvents()).toBe(1);
      expect(transport.pendingEvents()).toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("YAVIO-1201"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("retrying in"));
      await vi.advanceTimersByTimeAsync(10_000);
      await flushing;
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("a 429 before the last attempt still waits for Retry-After, and the last one gives up", async () => {
      const fetch = vi.fn().mockResolvedValue({
        status: 429,
        headers: { get: (name: string) => (name === "Retry-After" ? "2" : null) },
        json: () => ({}),
      });
      const transport = new HttpTransport({ ...base, maxRetries: 1, fetch });
      transport.send([fakeEvent()]);
      const flushing = transport.flush();
      await vi.advanceTimersByTimeAsync(1_900);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      await flushing;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(transport.lostEvents()).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it("a retry wait the deadline refuses gives up the whole queue: five batches, a 429 with Retry-After 5 s under a 1 s deadline — one request, every event counted lost once, one line", async () => {
      // Every request is answered 429 after 100 ms: the first answer lands
      // once the shutdown deadline is set, so it is the deadline refusing
      // the wait that decides, not the deadline timer.
      const fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  status: 429,
                  headers: { get: (name: string) => (name === "Retry-After" ? "5" : null) },
                  json: () => ({}),
                }),
              100,
            );
          }),
      );
      const losses: Array<[number, number]> = [];
      const transport = new HttpTransport({
        ...base,
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        maxRetries: 5,
        fetch,
        onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
      });
      // Five events, one per batch (the early flush at the batch size sends
      // the first at once; the deadline check is what matters).
      transport.send(Array.from({ length: 5 }, () => fakeEvent()));
      expect(fetch).toHaveBeenCalledTimes(1);
      const closing = transport.shutdown(1_000);
      // At 100 ms the first batch's 5 s wait would end after the deadline:
      // it is given up — and so is the queue behind it. Before the fix the
      // drain went on to the next batch at once, firing the remaining four
      // back-to-back with no backoff, the Retry-After ignored: five
      // requests into the same 429 within the second, every one of them
      // lost anyway.
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(transport.deadlineLostEvents()).toBe(5);
      expect(transport.lostEvents()).toBe(5);
      expect(transport.pendingEvents()).toBe(0);
      expect(losses).toEqual([[5, 1_000]]);
      // Nothing fired after the deadline either.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("an oversized Retry-After waits the fetch timeout, not 1 ms and not forever", async () => {
      let calls = 0;
      const fetch = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            status: 429,
            // 3 000 000 s: as milliseconds, past what setTimeout takes (Node clamps it to 1 ms).
            headers: { get: (name: string) => (name === "Retry-After" ? "3000000" : null) },
            json: () => ({}),
          });
        }
        return Promise.resolve(ok);
      });
      const transport = new HttpTransport({ ...base, fetch });
      transport.send([fakeEvent()]);
      const flushing = transport.flush();
      await vi.advanceTimersByTimeAsync(29_900);
      expect(fetch).toHaveBeenCalledTimes(1); // not retried at 1 ms
      await vi.advanceTimersByTimeAsync(200);
      await flushing;
      expect(fetch).toHaveBeenCalledTimes(2); // and not held for 35 days
    });

    it("a batch given up for good earlier — 503s, a 400 — is a delivery failure, not a deadline loss: a later healthy shutdown() reports nothing", async () => {
      let status = 503;
      const fetch = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ status, headers: { get: () => null }, json: () => ({}) }),
        );
      const losses: Array<[number, number]> = [];
      const transport = new HttpTransport({
        ...base,
        maxRetries: 1,
        flushIntervalMs: 60_000,
        fetch,
        onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
      });
      // 100 events: the early flush; 503 at 0 and 1 s, then given up after
      // the last attempt (YAVIO-1201) — at noon, hours before any shutdown.
      transport.send(Array.from({ length: 100 }, () => fakeEvent()));
      await vi.advanceTimersByTimeAsync(1_100);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("YAVIO-1201"));
      expect(transport.lostEvents()).toBe(100);
      expect(transport.deadlineLostEvents()).toBe(0);
      // An unexpected 4xx is given up at once, the same way.
      status = 400;
      transport.send([fakeEvent()]);
      await transport.flush();
      expect(transport.lostEvents()).toBe(101);
      expect(transport.deadlineLostEvents()).toBe(0);
      // A healthy drain later: the deadline gave nothing up, so no
      // YAVIO-1205 — the registry's cycle and exit lines read the same counter.
      status = 200;
      transport.send([fakeEvent()]);
      await transport.shutdown(1_000);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(losses).toEqual([]);
      expect(transport.deadlineLostEvents()).toBe(0);
      expect(transport.lostEvents()).toBe(101);
      expect(transport.pendingEvents()).toBe(0);
    });

    it("a send() after shutdown() began but before its deadline joins the drain; after the drain it is a counted drop; after the deadline the deadline's loss", async () => {
      const fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(ok), 200);
          }),
      );
      const losses: Array<[number, number]> = [];
      const transport = new HttpTransport({
        ...base,
        shutdownTimeoutMs: 1_000,
        flushIntervalMs: 60_000,
        fetch,
        onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
      });
      transport.send([fakeEvent()]);
      const closing = transport.shutdown();
      await vi.advanceTimersByTimeAsync(50); // the first batch is in flight
      // A request finishing during the healthy drain: before the fix this
      // was refused and counted as "refused after a shutdown deadline" —
      // the deadline was set, not reached — and reported as 1 lost.
      transport.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(500);
      await closing;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(losses).toEqual([]);
      expect(transport.deadlineLostEvents()).toBe(0);
      expect(transport.lostEvents()).toBe(0);
      expect(transport.pendingEvents()).toBe(0);

      // The drain is over, the deadline never reached: dropped and counted,
      // not as the deadline's.
      transport.send([fakeEvent()]);
      expect(transport.deadlineLostEvents()).toBe(0);
      expect(transport.lostEvents()).toBe(1);

      // A transport whose deadline was reached refuses: the deadline's loss.
      const { fetch: hanging } = abortableFetch();
      const late = new HttpTransport({ ...base, fetch: hanging, onShutdownLoss: () => {} });
      late.send([fakeEvent()]);
      const closingLate = late.shutdown(100);
      await vi.advanceTimersByTimeAsync(100);
      await closingLate;
      expect(late.deadlineLostEvents()).toBe(1);
      late.send([fakeEvent(), fakeEvent()]);
      expect(late.deadlineLostEvents()).toBe(3);
    });

    it("a post-signal transport: a fetch its budget cuts on its one attempt is a deadline loss, a refused connection a delivery failure", async () => {
      // `newTransport` after a signal: immediate, one attempt, a fetch
      // timeout of min(30 s, budget). The exit hook reports the first; the
      // second has its YAVIO-1201 line. The budget, not `fetchTimeoutMs`,
      // sets the 300 ms here: only its cut is the deadline's (#151).
      const { fetch: hanging } = abortableFetch();
      const cut = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchBudgetMs: () => 300,
        fetch: hanging,
      });
      cut.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(300);
      expect(cut.deadlineLostEvents()).toBe(1);
      expect(cut.lostEvents()).toBe(1);
      expect(cut.pendingEvents()).toBe(0);
      // The deadline's loss, not a delivery failure: no 1201 line for it
      // (#148 review round 7).
      expect(error.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).not.toContain(
        "YAVIO-1201",
      );

      const refused = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchBudgetMs: () => 300,
        fetch: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      refused.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(refused.deadlineLostEvents()).toBe(0);
      expect(refused.lostEvents()).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("YAVIO-1201"));
    });

    it("a post-signal transport: a fetch that runs into the fetch timeout with more budget left is a delivery failure with its 1201 line, not a deadline loss (#151)", async () => {
      // An explicit `shutdownTimeoutMs` above 30 s leaves a budget above the
      // fetch timeout, so the plain fetch timeout aborts the fetch, not the
      // budget. Before the fix any abort on a post-signal transport was
      // counted as the deadline's loss and had no 1201 line.
      const { fetch: hanging, aborted } = abortableFetch();
      const transport = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchTimeoutMs: 300,
        fetchBudgetMs: () => 10_000,
        fetch: hanging,
      });
      transport.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(299);
      expect(aborted()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted()).toBe(1); // the 300 ms fetch timeout, well before the 10 s budget
      expect(transport.deadlineLostEvents()).toBe(0);
      expect(transport.lostEvents()).toBe(1);
      expect(transport.pendingEvents()).toBe(0);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("YAVIO-1201"));
    });

    it("precountDue(): the batch in flight whose budget cuts its fetch by the time given is counted once, is no longer pending, and its loss is not a deadline loss again; a fetch the budget gives longer, and the queue behind it, are not due (#154)", async () => {
      // A post-signal transport at the cycle's deadline (t0 + 300): the
      // cycle's line counts the fetch that deadline cuts, before the app's
      // shutdown() returns and the app exits.
      const { fetch: hanging } = abortableFetch();
      const t0 = Date.now();
      const late = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchBudgetMs: (now) => t0 + 300 - now,
        fetch: hanging,
      });
      late.send([fakeEvent(), fakeEvent()]);
      late.send([fakeEvent()]); // queued behind the batch in flight
      await vi.advanceTimersByTimeAsync(0);
      expect(late.precountDue(t0 + 299)).toBe(0); // cut after that
      expect(late.precountDue(t0 + 300)).toBe(2);
      expect(late.precountDue(t0 + 300)).toBe(0); // once
      expect(late.pendingEvents()).toBe(1); // the queued one
      await vi.advanceTimersByTimeAsync(300); // the budget cuts it
      expect(late.deadlineLostEvents()).toBe(0); // the line has it already
      expect(late.lostEvents()).toBe(2);

      // The 100 ms floor of a send just before the deadline: its fetch
      // outlives the deadline, so it is not the deadline's to count.
      const { fetch: hanging2 } = abortableFetch();
      const floor = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchBudgetMs: () => 100,
        fetch: hanging2,
      });
      floor.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(floor.precountDue(Date.now() + 50)).toBe(0);
      expect(floor.pendingEvents()).toBe(1);
    });

    it("budgetCutAt(): the time a fetch's budget aborted it is recorded and reported; a fetch the plain fetch timeout aborts records nothing (#154 review round 3, #151's rule)", async () => {
      const { fetch: hanging } = abortableFetch();
      const t0 = Date.now();
      const reported: number[] = [];
      const cut = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchBudgetMs: (now) => t0 + 300 - now,
        onBudgetCut: (at) => reported.push(at),
        fetch: hanging,
      });
      cut.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(299);
      expect(cut.budgetCutAt()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(cut.budgetCutAt()).toBe(t0 + 300);
      expect(reported).toEqual([t0 + 300]);

      const { fetch: hanging2 } = abortableFetch();
      const timedOut = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchTimeoutMs: 300,
        fetchBudgetMs: () => 10_000,
        onBudgetCut: (at) => reported.push(at),
        fetch: hanging2,
      });
      timedOut.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(300);
      expect(timedOut.budgetCutAt()).toBeUndefined();
      expect(reported).toHaveLength(1);
    });

    it("an unparsable Retry-After falls back to the backoff, never to an immediate retry", async () => {
      let calls = 0;
      const fetch = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            status: 429,
            headers: { get: (name: string) => (name === "Retry-After" ? "soon" : null) },
            json: () => ({}),
          });
        }
        return Promise.resolve(ok);
      });
      const transport = new HttpTransport({ ...base, fetch });
      transport.send([fakeEvent()]);
      const flushing = transport.flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(fetch).toHaveBeenCalledTimes(1); // NaN meant "retry now" before #148
      await vi.advanceTimersByTimeAsync(500);
      await flushing;
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("a batch that cannot be serialized — a BigInt in metadata — is dropped and counted with one 1201 line; shutdown() resolves, the other batches go out, onClosed runs", async () => {
      const fetch = vi.fn().mockResolvedValue(ok);
      const onClosed = vi.fn();
      const transport = new HttpTransport({
        ...base,
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        fetch,
        onClosed,
      });
      // Three batches of one: the first goes out at once, the second cannot
      // be serialized, the third must still be delivered by the drain.
      // Before the fix `JSON.stringify` ran outside sendBatch's try: the
      // TypeError rejected the drain, shutdown() rejected, onClosed never
      // ran and the transport stayed in the registry's set for good.
      transport.send([
        fakeEvent({ event_name: "first" }),
        fakeEvent({ event_name: "second", metadata: { n: BigInt(1) } }),
        fakeEvent({ event_name: "third" }),
      ]);
      await transport.shutdown();
      const names = fetch.mock.calls.map(
        ([, init]) =>
          (JSON.parse((init as RequestInit).body as string).events[0] as BaseEvent).event_name,
      );
      expect(names).toEqual(["first", "third"]);
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/YAVIO-1201\] Could not serialize a batch of 1 events/),
      );
      expect(transport.lostEvents()).toBe(1);
      expect(transport.deadlineLostEvents()).toBe(0);
      expect(transport.pendingEvents()).toBe(0);
    });

    it("fetchBudgetMs() bounds each fetch, read per attempt and cut to fetchTimeoutMs", async () => {
      const { fetch, aborted } = abortableFetch();
      const budgets = [250, 5_000];
      const transport = new HttpTransport({
        ...base,
        immediate: true,
        maxRetries: 0,
        fetchTimeoutMs: 1_000,
        fetch,
        fetchBudgetMs: () => budgets.shift() ?? 0,
      });
      // The first send: a 250 ms budget — what is left of a signal cycle.
      transport.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(249);
      expect(aborted()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted()).toBe(1);
      expect(transport.deadlineLostEvents()).toBe(1); // the budget's cut on the one attempt
      // The next send asks again: 5 s, cut to the 1 s fetch timeout.
      transport.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(999);
      expect(aborted()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted()).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("a response that arrived in the same tick the deadline fired is delivered, not counted as lost: the timer only aborts, the outcome is counted where it is known", async () => {
      // The response is resolved by a timer registered before the deadline's,
      // so both fire in one synchronous tick: the 200 has arrived, its
      // continuation has not run, and the deadline timer sees the batch
      // still in flight. Before the fix it counted the batch as lost and
      // reported it in the 1205 line although ingest had accepted it.
      const fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(ok), 500);
          }),
      );
      const losses: Array<[number, number]> = [];
      const transport = new HttpTransport({
        ...base,
        immediate: true,
        flushIntervalMs: 60_000,
        fetch,
        onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
      });
      transport.send([fakeEvent()]);
      const closing = transport.shutdown(500);
      vi.advanceTimersByTime(500); // synchronous: no microtask between the two timers
      await closing;
      expect(transport.deadlineLostEvents()).toBe(0);
      expect(transport.lostEvents()).toBe(0);
      expect(losses).toEqual([]);
      expect(transport.pendingEvents()).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("YAVIO-1205"));
    });

    it("a fetch that ignores its abort signal: its batch is taken for lost ABORT_SETTLE_MS after the deadline, so no deadline waits for it", async () => {
      const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
      const losses: Array<[number, number]> = [];
      const transport = new HttpTransport({
        ...base,
        immediate: true,
        flushIntervalMs: 60_000,
        fetch,
        onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
      });
      transport.send([fakeEvent()]);
      let done = false;
      const closing = transport.shutdown(500).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(500 + ABORT_SETTLE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(transport.deadlineLostEvents()).toBe(1);
      expect(losses).toEqual([[1, 500]]);
      expect(transport.pendingEvents()).toBe(0);
    });

    it("a 207 whose body cannot be read is delivered — the status said accepted — not re-sent as a network error", async () => {
      const fetch = vi.fn().mockResolvedValue({
        status: 207,
        headers: { get: () => null },
        json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
      });
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
        transport.send([fakeEvent()]);
        const flushing = transport.flush();
        // Before the fix the failed body read fell into the network-error
        // branch: the accepted batch was re-sent at 1, 3, 7, 15 and 31 s,
        // then given up with a 1201 line.
        await vi.advanceTimersByTimeAsync(40_000);
        await flushing;
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(transport.lostEvents()).toBe(0);
        expect(transport.pendingEvents()).toBe(0);
        expect(warn).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("207 body unreadable"));
        // Under a deadline it is not the deadline's loss either.
        transport.send([fakeEvent()]);
        await transport.shutdown(500);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(transport.deadlineLostEvents()).toBe(0);
      } finally {
        stderr.mockRestore();
      }
    });

    it("a 207 whose body stalls past the deadline is delivered once — the body read is cut with the fetch, not counted as a loss at ABORT_SETTLE_MS and as delivered again when the body comes", async () => {
      // The status arrived; the body does not until 10 s later (a stalled
      // stream). Before the fix `response.json()` ran after the controller
      // was let go and the fetch timer cleared, so neither the timeout nor
      // the deadline could cut it: the deadline took the accepted batch for
      // lost 100 ms after it fired, and the body's arrival then counted it
      // delivered as well.
      const fetch = vi.fn().mockResolvedValue({
        status: 207,
        headers: { get: () => null },
        json: () => new Promise((resolve) => setTimeout(() => resolve({ rejected: 0 }), 10_000)),
      });
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const losses: Array<[number, number]> = [];
      try {
        const transport = new HttpTransport({
          ...base,
          immediate: true,
          flushIntervalMs: 60_000,
          fetch,
          onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
        });
        transport.send([fakeEvent()]);
        let done = false;
        const closing = transport.shutdown(500).then(() => {
          done = true;
        });
        await vi.advanceTimersByTimeAsync(500);
        const settledAtDeadline = done;
        await vi.advanceTimersByTimeAsync(ABORT_SETTLE_MS);
        await closing;
        // Nothing lost: the abort cut the body read and the batch is
        // delivered — the status said accepted — and the shutdown settled
        // at the deadline, not ABORT_SETTLE_MS later.
        expect(transport.deadlineLostEvents()).toBe(0);
        expect(settledAtDeadline).toBe(true);
        expect(transport.lostEvents()).toBe(0);
        expect(transport.deliveredEvents()).toBe(1);
        expect(transport.pendingEvents()).toBe(0);
        expect(losses).toEqual([]);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("207 body unreadable"));
        // The body coming later changes nothing: delivered once.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(transport.deliveredEvents()).toBe(1);
        expect(transport.deadlineLostEvents()).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        stderr.mockRestore();
      }
    });

    it("a 401 during the drain ends it: one request, one 1203 line with the dropped count, the rest a counted failure, a later send() dropped and counted", async () => {
      const fetch = createMockFetch(401);
      const onClosed = vi.fn();
      const losses: Array<[number, number]> = [];
      const transport = new HttpTransport({
        ...base,
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        fetch,
        onClosed,
        onShutdownLoss: (lost, deadlineMs) => losses.push([lost, deadlineMs]),
      });
      // Five batches of one; the first is in flight when shutdown() is called
      // and answers 401. Before the fix the 401 only set `stopped`: the drain
      // loop sent the other four into the same 401, one YAVIO-1203 line
      // each, and a send() during the drain still joined it.
      for (let i = 0; i < 5; i++) transport.send([fakeEvent()]);
      await transport.shutdown();
      expect(fetch).toHaveBeenCalledTimes(1);
      const lines = error.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((l: string) => l.includes("YAVIO-1203"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("5 events dropped");
      expect(transport.lostEvents()).toBe(5);
      expect(transport.deadlineLostEvents()).toBe(0); // no deadline was reached
      expect(losses).toEqual([]);
      expect(transport.pendingEvents()).toBe(0);
      expect(onClosed).toHaveBeenCalledTimes(1);

      transport.send([fakeEvent()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(transport.lostEvents()).toBe(6);
      expect(error).toHaveBeenCalledTimes(1); // no second line
    });
  });

  it("retryAfterMs(): delay-seconds, an HTTP-date from now, undefined otherwise", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      expect(retryAfterMs("2")).toBe(2_000);
      expect(retryAfterMs(" 0 ")).toBe(0);
      expect(retryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT")).toBe(5_000);
      expect(retryAfterMs("Wed, 31 Dec 2025 23:59:00 GMT")).toBe(0); // in the past: now
      expect(retryAfterMs("soon")).toBeUndefined();
      expect(retryAfterMs("1.5")).toBeUndefined();
      expect(retryAfterMs(null)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryAfterMs(): capped at the fetch timeout, as seconds and as a date — a value past 2^31−1 ms would be a 1 ms timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      expect(retryAfterMs("2147484")).toBe(30_000); // 2 147 484 000 ms: past the setTimeout range
      expect(MAX_RETRY_AFTER_MS).toBe(30_000);
      expect(retryAfterMs("31")).toBe(30_000);
      expect(retryAfterMs("99999999999999")).toBe(30_000);
      expect(retryAfterMs("Sat, 03 Jan 2026 00:00:00 GMT")).toBe(30_000); // two days out
      expect(retryAfterMs("30")).toBe(30_000);
      expect(retryAfterMs("29")).toBe(29_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks the size of the batch in flight", async () => {
    let hang = true;
    let release: (() => void) | undefined;
    const fetch = vi.fn().mockImplementation(() =>
      hang
        ? new Promise((resolve) => {
            release = () => resolve(ok);
          })
        : Promise.resolve(ok),
    );
    const transport = new HttpTransport({
      ...base,
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      fetch,
    });
    transport.send([fakeEvent(), fakeEvent(), fakeEvent()]);
    expect(transport.pendingEvents()).toBe(3); // the early flush at 2 is out, 1 queued
    release?.();
    await vi.waitFor(() => expect(transport.pendingEvents()).toBe(1));
    hang = false;
    await transport.shutdown();
    expect(transport.pendingEvents()).toBe(0);
  });

  /** Every `setTimeout` the test's code makes, with its delay, through the real timers. */
  function recordTimers() {
    const realSetTimeout = globalThis.setTimeout;
    const timers: Array<{ ms: number | undefined; handle: NodeJS.Timeout }> = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      const handle = realSetTimeout(fn, ms);
      timers.push({ ms, handle });
      return handle;
    }) as typeof setTimeout);
    const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
    return { timers, spy, sleep };
  }

  /** A Node timer that fired or was cleared (`_destroyed`, set by both). */
  const settled = (handle: NodeJS.Timeout) =>
    (handle as unknown as { _destroyed: boolean })._destroyed;

  it("outside a drain every timer it sets is unref'd: flush interval, fetch timeout, backoff (#148, #164)", async () => {
    const { timers, spy, sleep } = recordTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      const { fetch } = abortableFetch();
      const transport = new HttpTransport({
        ...base,
        fetchTimeoutMs: 30,
        maxRetries: 1,
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        fetch,
      });
      transport.start();
      transport.send([fakeEvent()]); // the early flush: no drain, no shutdown
      await sleep(60); // its fetch timeout fired, the backoff is scheduled
      expect(timers.map((t) => t.ms)).toEqual([30, 1_000]);
      expect(timers.map((t) => t.handle.hasRef())).toEqual([false, false]);
      expect((interval.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(false);
      await transport.shutdown(0);
    } finally {
      spy.mockRestore();
      interval.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("a drain's and a shutdown's deadline keep the process alive while they run and are cleared when they settle; every other timer stays unref'd (#164)", async () => {
    const { timers, spy, sleep } = recordTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The first attempt is answered 503, the second 200: the retry waits
      // out the 1 s backoff, and nothing but the deadline holds the loop.
      const fetch = vi
        .fn()
        .mockResolvedValueOnce({ status: 503, headers: { get: () => null }, json: () => ({}) })
        .mockResolvedValue(ok);
      const transport = new HttpTransport({
        ...base,
        shutdownTimeoutMs: 5_000,
        flushIntervalMs: 60_000,
        fetch,
      });
      transport.send([fakeEvent()]);
      const closing = transport.shutdown();
      await sleep(20); // the 503 is in, the backoff scheduled
      const deadline = timers.find((t) => t.ms === 5_000);
      const backoff = timers.find((t) => t.ms === 1_000);
      expect(deadline?.handle.hasRef()).toBe(true);
      expect(backoff?.handle.hasRef()).toBe(false);
      expect(timers.filter((t) => t.handle.hasRef())).toHaveLength(1);
      await closing;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(transport.deliveredEvents()).toBe(1);
      // Settled: the deadline timer is gone, so nothing outlives the drain.
      expect(timers.every((t) => settled(t.handle))).toBe(true);

      const draining = new HttpTransport({
        ...base,
        flushIntervalMs: 60_000,
        fetch: vi.fn().mockResolvedValue(ok),
      });
      draining.send([fakeEvent()]);
      const drained = draining.drain(2_000);
      const drainDeadline = timers.find((t) => t.ms === 2_000);
      expect(drainDeadline?.handle.hasRef()).toBe(true);
      await drained;
      expect(settled(drainDeadline?.handle as NodeJS.Timeout)).toBe(true);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

/**
 * Cloudflare Workers (#171): workerd rejects a `fetch` called with another
 * `this` ("Illegal invocation") and any timer outside a request ("Disallowed
 * operation called within global scope"). On 0.5.5 the first made every
 * batch a network error and the second made a module-scope `createYavio()`
 * fail the Worker's load.
 */
describe("HttpTransport on Cloudflare Workers (#171)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls the global fetch with globalThis as `this`", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) {
      seen.push(this);
      return Promise.resolve({ status: 200, headers: { get: () => null }, json: () => ({}) });
    });
    const transport = new HttpTransport({
      endpoint: "http://test/v1/events",
      apiKey: "yav_test",
      sdkVersion: "0.0.1",
    });
    transport.send([fakeEvent()]);
    await transport.flush();
    expect(seen).toEqual([globalThis]);
    expect(transport.deliveredEvents()).toBe(1);
  });

  it("start() arms no timer: the flush interval is armed by the first send, once, and then sends on its own", async () => {
    vi.useFakeTimers();
    try {
      const interval = vi.spyOn(globalThis, "setInterval");
      const fetch = createMockFetch();
      const transport = new HttpTransport({
        endpoint: "http://test/v1/events",
        apiKey: "yav_test",
        sdkVersion: "0.0.1",
        flushIntervalMs: 1_000,
        fetch,
      });
      transport.start();
      expect(interval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      transport.send([fakeEvent()]);
      transport.send([fakeEvent()]);
      expect(interval).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledOnce();
      await transport.shutdown(0);
      transport.send([fakeEvent()]); // refused after the shutdown: no interval again
      expect(interval).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `flushQueued()`, what `client.flush()` runs on the key's transport (#171):
 * C1 nothing dropped or aborted at its deadline; C2 a batch waiting for its
 * retry retried at once when its last attempt is a second old, once per
 * flush, not counted towards `maxRetries` and without a retry line, a
 * `Retry-After` (429 or 5xx) never cut; C3 a fetch an earlier flush left
 * older than the bound taken back and its batch re-sent unchanged, first.
 */
describe("HttpTransport.flushQueued() (#171)", () => {
  const base = { endpoint: "http://test/v1/events", apiKey: "yav_test", sdkVersion: "0.0.1" };
  const answer = (status: number, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => ({}),
  });
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  const lines = (code: string) =>
    [...warn.mock.calls, ...error.mock.calls]
      .map((c) => String(c[0]))
      .filter((l) => l.includes(code));

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A fetch that answers each call with the next of `script`: a status, "hang" (until aborted) or "reject" (a network error). */
  function scriptedFetch(
    script: Array<number | "hang" | "reject">,
    fallback: number | "hang" = 200,
  ) {
    const bodies: Array<{ events: Array<{ event_id: string }> }> = [];
    let aborted = 0;
    const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      const next = script.shift() ?? fallback;
      if (next === "reject") return Promise.reject(new TypeError("fetch failed"));
      if (next === "hang") {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted++;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      return Promise.resolve(answer(next));
    });
    return { fetch, bodies, aborted: () => aborted };
  }

  it("C2: a batch waiting for its retry is retried at once by a flush once its last attempt is a second old, once per flush — six flush-triggered failures leave the time-based retry at its next step (retry 3/5), without a line of their own", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { fetch } = scriptedFetch([], 503);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent()]);
    // 503 and a 1 s backoff, past the 500 ms deadline: the attempt is fresh,
    // so no early retry (#171 review round 1) — the flush returns.
    expect(await transport.flushQueued(500)).toBe("retrying");
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); // the backoff runs out: 503, a 2 s backoff
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1_000); // the last attempt is a second old
      expect(await transport.flushQueued(500)).toBe("retrying");
    }
    expect(fetch).toHaveBeenCalledTimes(8); // two attempts, six early retries
    expect(lines("YAVIO-1200")).toEqual([
      "[YAVIO-1200] Server error 503, retry 1/5",
      "[YAVIO-1200] Server error 503, retry 2/5",
    ]);
    expect(transport.pendingEvents()).toBe(1); // nothing dropped, nothing given up
    expect(transport.lostEvents()).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000); // the last early retry's backoff runs out
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(lines("YAVIO-1200")).toEqual([
      "[YAVIO-1200] Server error 503, retry 1/5",
      "[YAVIO-1200] Server error 503, retry 2/5",
      "[YAVIO-1200] Server error 503, retry 3/5",
    ]);
    const closing = transport.shutdown(0);
    await vi.advanceTimersByTimeAsync(ABORT_SETTLE_MS);
    await closing;
  });

  it("C2: a flush retries early only when the last attempt is a second old — a host that flushes after every one of many requests does not retry once per request (#171 review round 1)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { fetch } = scriptedFetch([], 503);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent()]);
    // A request every 20 ms for 3 s, each with its flush.
    for (let t = 0; t < 3_000; t += 20) {
      void transport.flushQueued(500);
      await vi.advanceTimersByTimeAsync(20);
    }
    // 0 s, the backoff at 1 s, early retries at about 2 s and 3 s.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(5);
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    const closing = transport.shutdown(0);
    await vi.advanceTimersByTimeAsync(ABORT_SETTLE_MS);
    await closing;
  });

  it("a 503 with Retry-After is honoured like a 429's: the wait is the header's, and a flush does not cut it (#171 review round 1)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let calls = 0;
    const fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(calls === 1 ? answer(503, { "Retry-After": "3" }) : answer(200));
    });
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent()]);
    expect(await transport.flushQueued(500)).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1_500); // past the 1 s backoff a 503 alone would get
    expect(await transport.flushQueued(500)).toBe("retrying"); // a second old, still not cut
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500); // the 3 s the header asked for
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(transport.deliveredEvents()).toBe(1);
  });

  it("C2: a network error's early retry prints no YAVIO-1200 line, and a success after it delivers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { fetch } = scriptedFetch(["reject", "reject", "reject"]);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent()]);
    expect(await transport.flushQueued(500)).toBe("retrying"); // fails, a 1 s backoff
    await vi.advanceTimersByTimeAsync(1_000); // the backoff: fails, a 2 s backoff
    expect(lines("YAVIO-1200")).toEqual([
      "[YAVIO-1200] Network error, retry 1/5",
      "[YAVIO-1200] Network error, retry 2/5",
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await transport.flushQueued(500)).toBe("retrying"); // its early retry fails: no line
    expect(lines("YAVIO-1200")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await transport.flushQueued(500)).toBe("done"); // its early retry delivers
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(transport.deliveredEvents()).toBe(1);
    expect(lines("YAVIO-1201")).toEqual([]);
  });

  it("C2: a 429 Retry-After is never cut — past the deadline the flush returns at once, within it the flush waits it out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let calls = 0;
    const fetch = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve(answer(429, { "Retry-After": "2" }));
      if (calls === 2) return Promise.resolve(answer(429, { "Retry-After": "1" }));
      return Promise.resolve(answer(200));
    });
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent()]);
    expect(await transport.flushQueued(500)).toBe("retrying"); // 2 s: past the deadline
    expect(await transport.flushQueued(500)).toBe("retrying"); // not cut by a second flush either
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000); // the wait ends: 429 with 1 s
    expect(fetch).toHaveBeenCalledTimes(2);
    const flushing = transport.flushQueued(1_500); // 1 s ends within the deadline: waited out
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await flushing).toBe("done");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(transport.deliveredEvents()).toBe(1);
  });

  it("C3: a fetch in flight for longer than the flush's budget is aborted and its batch re-sent first — the same events in the same order — not counted as an attempt and without a retry line", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { fetch, bodies, aborted } = scriptedFetch(["hang"]);
    // maxRetries 0: counted as an attempt, the aborted batch would be given up.
    const transport = new HttpTransport({
      ...base,
      maxBatchSize: 2,
      maxRetries: 0,
      flushIntervalMs: 60_000,
      fetch,
    });
    transport.send([fakeEvent(), fakeEvent()]); // the early flush at 2: out, hanging
    transport.send([fakeEvent()]);
    const first = transport.flushQueued(100); // the fetch is fresh: waited on, not aborted
    await vi.advanceTimersByTimeAsync(150);
    expect(await first).toBe("deadline");
    expect(aborted()).toBe(0);
    transport.send([fakeEvent()]);
    expect(await transport.flushQueued(100)).toBe("done"); // 150 ms old: aborted, re-sent
    expect(aborted()).toBe(1);
    const ids = bodies.map((b) => b.events.map((e) => e.event_id));
    expect(ids).toHaveLength(3);
    expect(ids[1]).toEqual(ids[0]); // the resend, as it was, before anything queued after it
    expect(ids[2]).toHaveLength(2);
    expect(ids[2]).not.toContain(ids[0]?.[0]);
    expect(transport.deliveredEvents()).toBe(4);
    expect(transport.lostEvents()).toBe(0);
    expect(lines("YAVIO-1200")).toEqual([]);
    expect(lines("YAVIO-1201")).toEqual([]);
  });

  it("C1: at its deadline a flush drops and aborts nothing — the fetch in flight goes on, what is queued stays queued, both go out later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let release: (() => void) | undefined;
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          release = () => resolve(answer(200));
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const transport = new HttpTransport({
      ...base,
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      fetch,
    });
    transport.send([fakeEvent(), fakeEvent(), fakeEvent()]);
    const flushing = transport.flushQueued(200);
    await vi.advanceTimersByTimeAsync(200);
    expect(await flushing).toBe("deadline");
    expect(transport.pendingEvents()).toBe(3);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    const second = transport.flushQueued(200); // the third event's fetch, hanging
    await vi.advanceTimersByTimeAsync(200);
    expect(await second).toBe("deadline");
    expect(transport.deliveredEvents()).toBe(2);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.deliveredEvents()).toBe(3);
    expect(transport.lostEvents()).toBe(0);
  });

  it("the flush's deadline timer holds the event loop while it runs and is cleared when it ends; the backoff stays unref'd (#164's rule)", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timers: Array<{ ms: number | undefined; handle: NodeJS.Timeout }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      const handle = realSetTimeout(fn, ms);
      timers.push({ ms, handle });
      return handle;
    }) as typeof setTimeout);
    const settled = (handle: NodeJS.Timeout) =>
      (handle as unknown as { _destroyed: boolean })._destroyed;
    const { fetch } = scriptedFetch([503, "hang"]);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent()]);
    // 503, the 1 s backoff ends within the deadline and is waited out, the
    // retry hangs until the deadline.
    const flushing = transport.flushQueued(1_500);
    // The deadline, and nothing else: from the absolute deadline, so a
    // millisecond spent starting the first fetch shows.
    const held = timers.filter((t) => t.handle.hasRef());
    expect(held).toHaveLength(1);
    expect(held[0]?.ms).toBeGreaterThan(1_450);
    expect(held[0]?.ms).toBeLessThanOrEqual(1_500);
    expect(await flushing).toBe("deadline");
    expect(settled(held[0]?.handle as NodeJS.Timeout)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const backoff = timers.find((t) => t.ms === 1_000);
    expect(backoff?.handle.hasRef()).toBe(false);
    expect(timers.filter((t) => t.ms === 30_000).every((t) => !t.handle.hasRef())).toBe(true); // fetch timeouts
    expect(timers.filter((t) => t.handle.hasRef())).toHaveLength(1); // the flush's own wake-ups are unref'd too
    await transport.shutdown(0);
  });

  it.each([
    ["a flush without a hold", 1_500, "deadline"],
    ["a hold with a millisecond left", 1_501, "deadline"],
  ])(
    "when the deadline timer fires a millisecond early against Date.now(), %s arms no hold: no second ref'd timer, and the flush ends at its deadline (#171 review round 3)",
    async (_label, holdMs, outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const fakeSetTimeout = globalThis.setTimeout;
      const timers: Array<{ ms: number | undefined; handle: NodeJS.Timeout }> = [];
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: (...args: unknown[]) => void,
        ms?: number,
      ) => {
        const handle = fakeSetTimeout(fn, ms);
        timers.push({ ms, handle });
        return handle;
      }) as typeof setTimeout);
      const { fetch } = scriptedFetch(["hang"]);
      const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
      transport.send([fakeEvent()]);
      let ended: string | undefined;
      void transport.flushQueued(1_500, 1_500, holdMs).then((o) => {
        ended = o;
      });
      await vi.advanceTimersByTimeAsync(1_499);
      // Node's timers run on a monotonic clock, Date.now() on the wall clock:
      // the two may disagree by a millisecond. Here Date.now() lags by one.
      vi.setSystemTime(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(timers.filter((t) => t.handle.hasRef()).map((t) => t.ms)).toEqual([1_500]);
      expect(ended).toBe(outcome);
      const stopping = transport.shutdown(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
    },
  );
});

/**
 * Cloudflare Workers' rules, emulated in Node (#171 review round 1): a fetch
 * or timer belongs to the request that started it, and once that request has
 * ended its fetch never settles — not even when aborted — and its timer
 * never fires. On 0.5.6's first cut the shared transport wedged for good: the
 * one in-flight slot waited on the dead send, and every later event in the
 * isolate stayed queued.
 */
describe("HttpTransport.flushQueued() and a send another request left behind (#171)", () => {
  const base = { endpoint: "http://test/v1/events", apiKey: "yav_test", sdkVersion: "0.0.1" };
  const answer = (status: number, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => ({}),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a fetch that never settles, not even on abort: the next flush takes the batch back and re-sends it, the queue behind it goes out, and the dead fetch's late answer is not counted", async () => {
    const bodies: string[][] = [];
    let answerLate: (() => void) | undefined;
    const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      bodies.push(
        (JSON.parse(init.body as string) as { events: Array<{ event_id: string }> }).events.map(
          (e) => e.event_id,
        ),
      );
      if (bodies.length === 1) {
        // The request that started it has ended: no answer, no abort.
        return new Promise((resolve) => {
          answerLate = () => resolve(answer(200));
        });
      }
      return Promise.resolve(answer(200));
    });
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent(), fakeEvent()]);
    const first = transport.flushQueued(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBe("deadline");
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z")); // the next request, no timer ran
    transport.send([fakeEvent()]);
    const second = transport.flushQueued(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBe("done");
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]); // re-sent as it was, first
    expect(bodies[2]).toHaveLength(1);
    expect(transport.deliveredEvents()).toBe(3);
    expect(transport.pendingEvents()).toBe(0);
    answerLate?.(); // the dead fetch answers after all (in Node; on Workers never)
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.deliveredEvents()).toBe(3);
    expect(transport.pendingEvents()).toBe(0);
    transport.send([fakeEvent()]); // the slot is free: the next event goes out
    expect(await transport.flushQueued(100)).toBe("done");
    expect(transport.deliveredEvents()).toBe(4);
  });

  it("a retry wait whose timer never fires (a Retry-After a flush may not cut): once its end has passed, the next flush sends the retry itself", async () => {
    let calls = 0;
    const fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(calls === 1 ? answer(429, { "Retry-After": "2" }) : answer(200));
    });
    const transport = new HttpTransport({ ...base, flushIntervalMs: 60_000, fetch });
    transport.send([fakeEvent()]);
    expect(await transport.flushQueued(100)).toBe("retrying");
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z")); // its timer never ran
    const next = transport.flushQueued(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await next).toBe("done");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(transport.deliveredEvents()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000); // the old timer, had it survived: nothing more
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(transport.deliveredEvents()).toBe(1);
  });

  it("a drain() waiting on a send that a flush takes back from its retry wait resolves once the batch is delivered, not at its own deadline (#171 review round 2)", async () => {
    let calls = 0;
    const fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(answer(calls <= 2 ? 503 : 200));
    });
    const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
    transport.send([fakeEvent()]);
    const t0 = Date.now();
    let drainedAt: number | undefined;
    // Another holder's shutdown() while this client's flushes go on.
    const draining = transport.drain(4_000).then(() => {
      drainedAt = Date.now() - t0;
    });
    await vi.advanceTimersByTimeAsync(1_000); // 503 at 0, the backoff's retry at 1 s: 503, a 2 s wait
    await vi.advanceTimersByTimeAsync(1_000); // the attempt is a second old
    const flushing = transport.flushQueued(500); // an early retry: 200
    await vi.advanceTimersByTimeAsync(10);
    expect(await flushing).toBe("done");
    expect(transport.deliveredEvents()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(drainedAt).toBeDefined();
    expect(drainedAt).toBeLessThan(2_200);
    await draining;
  });

  /** A fetch answering after `ms` (never, with Infinity) that honours abort; it records each call. */
  const slowFetch = (ms: number) => {
    const t0 = Date.now();
    const calls: Array<{ at: number; n: number; aborted: boolean }> = [];
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const call = {
            at: Date.now() - t0,
            n: (JSON.parse(init.body as string) as { events: unknown[] }).events.length,
            aborted: false,
          };
          calls.push(call);
          const timer = Number.isFinite(ms)
            ? setTimeout(() => resolve(answer(200)), ms)
            : undefined;
          init.signal?.addEventListener("abort", () => {
            call.aborted = true;
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    return { fetch, calls, t0 };
  };

  it("a burst against an ingest slower than the budget: the holding flush's send is not taken back, the concurrent flush gives up at its own budget with 'deadline', and the holder sends its events next (#171 review round 3)", async () => {
    const { fetch, calls, t0 } = slowFetch(1_500);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
    const ended: Record<string, [string, number]> = {};
    const track = (name: string, flushing: Promise<string>) =>
      void flushing.then((outcome) => {
        ended[name] = [outcome, Date.now() - t0];
      });
    transport.send([fakeEvent()]); // request A's event
    track("a", transport.flushQueued(1_000, 1_000, 10_000)); // flushWhenSent's: holds up to 10 s
    await vi.advanceTimersByTimeAsync(200);
    transport.send([fakeEvent()]); // request B's event
    track("b", transport.flushQueued(1_000, 1_000, 10_000));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(transport.deliveredEvents()).toBe(2);
    expect(transport.pendingEvents()).toBe(0);
    expect(calls).toEqual([
      { at: 0, n: 1, aborted: false }, // A's, not taken back by B
      { at: 1_500, n: 1, aborted: false }, // B's event, sent by A once its own was answered
    ]);
    expect(ended).toEqual({ b: ["deadline", 1_200], a: ["done", 3_000] });
  });

  it("a holder whose next round trip no longer fits before its holdAt leaves the queue for the next request and returns 'deadline', not 'done' (#171 review round 3)", async () => {
    const { fetch, calls, t0 } = slowFetch(1_500);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
    const ended: Record<string, [string, number]> = {};
    const track = (name: string, flushing: Promise<string>) =>
      void flushing.then((outcome) => {
        ended[name] = [outcome, Date.now() - t0];
      });
    transport.send([fakeEvent()]);
    track("a", transport.flushQueued(1_000, 1_000, 2_500)); // holds to 2500 at most
    await vi.advanceTimersByTimeAsync(200);
    transport.send([fakeEvent()]);
    track("b", transport.flushQueued(1_000, 1_000, 2_500));
    await vi.advanceTimersByTimeAsync(3_000);
    // A's answer at 1500; another 1.5 s round trip would end past 2500: not started.
    expect(ended).toEqual({ b: ["deadline", 1_200], a: ["deadline", 1_500] });
    expect(calls).toHaveLength(1);
    expect(transport.deliveredEvents()).toBe(1);
    expect(transport.pendingEvents()).toBe(1);
  });

  it("a hold that runs into its holdAt leaves nothing registered when it resolves: its loop sets no watch after the flush's finally ended them (#171 review round 3)", async () => {
    const { fetch } = slowFetch(Number.POSITIVE_INFINITY);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
    const inner = transport as unknown as {
      slotWatchers: Set<unknown>;
      retryWaitWatchers: Set<unknown>;
    };
    transport.send([fakeEvent()]);
    let atEnd: number[] | undefined;
    void transport.flushQueued(1_000, 1_000, 1_500).then(() => {
      // On Workers the request ends here: whatever is registered now stays.
      atEnd = [inner.slotWatchers.size, inner.retryWaitWatchers.size];
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(atEnd).toEqual([0, 0]);
  });

  it("against a hanging ingest the hold stays bounded: one holder until its holdAt, 'deadline'; a concurrent flush returns at its own budget; once the holder is gone, the next flush takes the batch back (#171 review round 3)", async () => {
    const { fetch, calls, t0 } = slowFetch(Number.POSITIVE_INFINITY);
    const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
    const ended: Record<string, [string, number]> = {};
    const track = (name: string, flushing: Promise<string>) =>
      void flushing.then((outcome) => {
        ended[name] = [outcome, Date.now() - t0];
      });
    transport.send([fakeEvent()]);
    track("a", transport.flushQueued(1_000, 1_000, 5_000));
    await vi.advanceTimersByTimeAsync(200);
    transport.send([fakeEvent()]);
    track("b", transport.flushQueued(1_000, 1_000, 5_000));
    await vi.advanceTimersByTimeAsync(5_000); // to 5200
    // B: no hold, its own fetch is not out; A: held to its holdAt, nothing new started meanwhile.
    expect(ended).toEqual({ b: ["deadline", 1_200], a: ["deadline", 5_000] });
    expect(calls).toEqual([{ at: 0, n: 1, aborted: false }]);
    track("c", transport.flushQueued(1_000, 1_000, 5_000)); // the next request, at 5200
    await vi.advanceTimersByTimeAsync(10);
    // Its holder gone, the batch is taken back and re-sent first, by C, which holds it now.
    expect(calls).toEqual([
      { at: 0, n: 1, aborted: true },
      { at: 5_200, n: 1, aborted: false },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended.c).toEqual(["deadline", 10_200]);
  });

  it.each([
    [2, 10],
    [100, 10_000],
  ])(
    "drain() of a full buffer (batches of %d, a cap of %d) delivers all of it: its bound counts batches, not rounds (#171 review round 3)",
    async (maxBatchSize, maxBufferSize) => {
      const fetch = vi.fn().mockImplementation(() => Promise.resolve(answer(200)));
      const transport = new HttpTransport({
        ...base,
        flushIntervalMs: 3_600_000,
        maxBatchSize,
        maxBufferSize,
        fetch,
      });
      transport.send(Array.from({ length: maxBufferSize }, () => fakeEvent())); // one send: no early flush
      await transport.drain(10_000);
      expect(transport.deliveredEvents()).toBe(maxBufferSize);
      expect(fetch).toHaveBeenCalledTimes(maxBufferSize / maxBatchSize);
    },
  );

  it.each([
    ["one 25 s answer (a slow ingest)", 25_000, 5_000],
    ["one answer that spanned a 10-minute freeze", 600_000, 2_000],
  ])(
    "after %s, the next hung fetch is taken back within a few budgets, not at the 30 s fetch timeout (#171 review round 2)",
    async (_label, firstMs, within) => {
      const pending: Array<{ resolve: (r: unknown) => void; aborted: boolean }> = [];
      const fetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((resolve, reject) => {
            const call = { resolve, aborted: false };
            pending.push(call);
            init.signal?.addEventListener("abort", () => {
              call.aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
      transport.send([fakeEvent()]);
      void transport.flushQueued(1_000);
      // A freeze moves the clock and runs no timer; a slow answer just takes long.
      if (firstMs > 30_000) vi.setSystemTime(Date.now() + firstMs);
      else await vi.advanceTimersByTimeAsync(firstMs - 1);
      pending[0]?.resolve(answer(200));
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.deliveredEvents()).toBe(1);
      transport.send([fakeEvent()]); // its fetch hangs
      const started = Date.now();
      void transport.flushQueued(1_000); // starts it: its own, never taken back by it
      await vi.advanceTimersByTimeAsync(1_000);
      while (!pending[1]?.aborted && Date.now() - started < 40_000) {
        void transport.flushQueued(1_000); // a request every second, each flushes
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(pending[1]?.aborted).toBe(true);
      expect(Date.now() - started).toBeLessThanOrEqual(within);
    },
  );

  it("a flush that watched another request's send leaves nothing on it once it ends: no then() on its promise, no watcher (workerd's \"different request context\" warning, #171 review round 2)", async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {})); // never answers
    const transport = new HttpTransport({ ...base, flushIntervalMs: 3_600_000, fetch });
    transport.send([fakeEvent()]);
    const first = transport.flushQueued(1_000); // request 1's: it starts the send
    await vi.advanceTimersByTimeAsync(10);
    const inner = transport as unknown as {
      inflight: Promise<void>;
      slotWatchers: Set<unknown>;
      retryWaitWatchers: Set<unknown>;
    };
    // Request 1 still waits for it (its flush holds); request 2's flush watches it, then ends.
    const then = vi.spyOn(inner.inflight, "then");
    const second = transport.flushQueued(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await second).toBe("deadline");
    expect(then).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toBe("deadline");
    expect(inner.slotWatchers.size).toBe(0);
    expect(inner.retryWaitWatchers.size).toBe(0);
  });
});
