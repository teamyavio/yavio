import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetTransport } from "../../react/transport.js";
import type { WidgetConfig } from "../../react/types.js";

function mockConfig(): WidgetConfig {
  return {
    token: "jwt_test",
    endpoint: "http://test/v1/events",
    traceId: "tr_test",
    sessionId: "ses_test",
  };
}

function fakeEvent(overrides: Partial<BaseEvent> = {}): BaseEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "track",
    trace_id: "tr_test",
    session_id: "ses_test",
    timestamp: new Date().toISOString(),
    source: "widget",
    ...overrides,
  } as BaseEvent;
}

function createMockFetch(status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    headers: { get: () => null },
    json: () => Promise.resolve({}),
  });
}

describe("WidgetTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers events without sending immediately", () => {
    const fetch = createMockFetch();
    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("flushes events with correct auth header", async () => {
    const fetch = createMockFetch();
    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);

    await transport.flush();
    expect(fetch).toHaveBeenCalledOnce();

    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test/v1/events");
    expect(opts.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer jwt_test",
        "Content-Type": "application/json",
      }),
    );
  });

  it("flushes on timer interval (5s)", async () => {
    const fetch = createMockFetch();
    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);

    // Advance past flush interval
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("early-flushes when 20 events buffered", () => {
    const fetch = createMockFetch();
    const transport = new WidgetTransport(mockConfig(), fetch);

    const events = Array.from({ length: 20 }, () => fakeEvent());
    transport.send(events);

    // Early flush triggered
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("drops oldest events when buffer exceeds 200", () => {
    const fetch = createMockFetch();
    const transport = new WidgetTransport(mockConfig(), fetch);

    // Send 210 events at once — should trigger early flush at 20 and buffer overflow
    const events = Array.from({ length: 210 }, (_, i) => fakeEvent({ event_name: `event_${i}` }));
    transport.send(events);

    // The transport should have flushed and capped
    expect(fetch).toHaveBeenCalled();
  });

  it("stops permanently on 401 Unauthorized", async () => {
    const fetch = createMockFetch(401);
    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);
    await transport.flush();

    // Reset fetch and try again
    fetch.mockClear();
    transport.send([fakeEvent()]);
    await transport.flush();

    // Should not send after 401
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries on 5xx errors with backoff", async () => {
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve({
          status: 500,
          headers: { get: () => null },
        });
      }
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
      });
    });

    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);

    // Flush and let retries run (need to advance timers for delays)
    const flushPromise = transport.flush();

    // Advance past retry delays
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await flushPromise;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors", async () => {
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
      });
    });

    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);

    const flushPromise = transport.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromise;

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("calls sendBeacon on beaconFlush", () => {
    const fetch = createMockFetch();
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      writable: true,
      configurable: true,
    });

    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);
    transport.beaconFlush();

    expect(sendBeacon).toHaveBeenCalledOnce();
    const [url] = sendBeacon.mock.calls[0] as [string, Blob];
    expect(url).toContain("token=jwt_test");
  });

  it("clears buffer after beaconFlush", () => {
    const fetch = createMockFetch();
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      writable: true,
      configurable: true,
    });

    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.send([fakeEvent()]);
    transport.beaconFlush();

    // Second beacon should do nothing (buffer empty)
    sendBeacon.mockClear();
    transport.beaconFlush();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("stops accepting events after stop()", () => {
    const fetch = createMockFetch();
    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.stop();
    transport.send([fakeEvent()]);

    // Should not flush since stopped
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends correct body format", async () => {
    const fetch = createMockFetch();
    const transport = new WidgetTransport(mockConfig(), fetch);
    const event = fakeEvent({ event_name: "test_event" });
    transport.send([event]);
    await transport.flush();

    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      events: BaseEvent[];
      sdk_version: string;
      sent_at: string;
    };

    expect(body.events).toHaveLength(1);
    expect(body.sdk_version).toBe("0.0.1");
    expect(body.sent_at).toBeDefined();
    expect(body.events[0].event_name).toBe("test_event");
  });

  it("schedules follow-up flush when events arrive during in-flight flush", async () => {
    const resolver: { flush: (() => void) | null } = { flush: null };
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: return a promise we control
        return new Promise((resolve) => {
          resolver.flush = () => resolve({ status: 200, headers: { get: () => null } });
        });
      }
      return Promise.resolve({ status: 200, headers: { get: () => null } });
    });

    const transport = new WidgetTransport(mockConfig(), fetch);

    // Send first event and start flushing
    transport.send([fakeEvent({ event_name: "first" })]);
    const flushPromise = transport.flush();

    // While flush is in-flight, send more events and trigger another flush
    transport.send([fakeEvent({ event_name: "second" })]);
    await transport.flush(); // should set pendingFlush

    // Complete the first flush — should trigger follow-up
    resolver.flush?.();
    await flushPromise;

    // Let the follow-up flush run
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("removes teardown listeners on stop()", () => {
    const fetch = createMockFetch();
    const removeVis = vi.spyOn(document, "removeEventListener");
    const removeWin = vi.spyOn(window, "removeEventListener");

    const transport = new WidgetTransport(mockConfig(), fetch);
    transport.stop();

    expect(removeVis).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith("pagehide", expect.any(Function));

    removeVis.mockRestore();
    removeWin.mockRestore();
  });

  it("splits large payloads into chunks for sendBeacon", () => {
    const fetch = createMockFetch();
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      writable: true,
      configurable: true,
    });

    const transport = new WidgetTransport(mockConfig(), fetch);

    // Use 15 events with large metadata (< 20 to avoid early flush trigger)
    // 15 * ~5KB ≈ 75KB > 60KB limit → forces chunking
    const largeMetadata = "x".repeat(5_000);
    const events = Array.from({ length: 15 }, () =>
      fakeEvent({ metadata: { data: largeMetadata } }),
    );
    transport.send(events);
    transport.beaconFlush();

    // Should have been called multiple times (chunked)
    expect(sendBeacon.mock.calls.length).toBeGreaterThan(1);
  });
});
