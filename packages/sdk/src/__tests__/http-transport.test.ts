import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../transport/http.js";

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

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown timeout — events may have been dropped"),
    );
    warnSpy.mockRestore();
  });
});
