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
    expect(vi.getTimerCount()).toBe(1); // the flush interval
    transport.send([fakeEvent()]);
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
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
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
        expect(debug).toHaveBeenCalledWith(expect.stringContaining("207 body unreadable"));
        // Under a deadline it is not the deadline's loss either.
        transport.send([fakeEvent()]);
        await transport.shutdown(500);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(transport.deadlineLostEvents()).toBe(0);
      } finally {
        debug.mockRestore();
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
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
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
        expect(debug).toHaveBeenCalledWith(expect.stringContaining("207 body unreadable"));
        // The body coming later changes nothing: delivered once.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(transport.deliveredEvents()).toBe(1);
        expect(transport.deadlineLostEvents()).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        debug.mockRestore();
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

  it("every timer it sets is unref'd: fetch timeout, backoff, drain and shutdown deadlines", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const handles: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
    ) => {
      const handle = realSetTimeout(fn, ms);
      handles.push(handle);
      return handle;
    }) as typeof setTimeout);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fetch } = abortableFetch();
      const transport = new HttpTransport({
        ...base,
        fetchTimeoutMs: 30,
        maxRetries: 1,
        shutdownTimeoutMs: 5_000,
        flushIntervalMs: 60_000,
        fetch,
      });
      transport.send([fakeEvent()]);
      const draining = transport.drain(100); // its deadline timer
      await new Promise((resolve) => realSetTimeout(resolve, 60)); // fetch timeout fired, backoff scheduled
      await draining;
      const closing = transport.shutdown(); // its deadline timer
      await new Promise((resolve) => realSetTimeout(resolve, 10));
      expect(handles.length).toBeGreaterThanOrEqual(4);
      expect(handles.map((h) => h.hasRef())).toEqual(handles.map(() => false));
      // The second attempt's fetch timeout ends it: the shutdown resolves at ~1.06 s.
      await closing;
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
