import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpTransport, MAX_RETRY_AFTER_MS, retryAfterMs } from "../transport/http.js";

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
    const fetch = vi.fn().mockImplementation(
      () => new Promise(() => {}), // never resolves
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
