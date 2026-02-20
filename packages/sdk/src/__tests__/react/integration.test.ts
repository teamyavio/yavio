import { renderHook } from "@testing-library/react";
import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetWidgetInstance, useYavio } from "../../react/hook.js";

describe("React Widget SDK Integration", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let sentBatches: Array<{ events: BaseEvent[]; sdk_version: string; sent_at: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetWidgetInstance();
    sentBatches = [];
    fetchSpy = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string) as {
        events: BaseEvent[];
        sdk_version: string;
        sent_at: string;
      };
      sentBatches.push(body);
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.__YAVIO__ = undefined;
  });

  it("full flow: config → init → identify → step → track → conversion → flush", async () => {
    window.__YAVIO__ = {
      token: "jwt_integration",
      endpoint: "http://ingest.test/v1/events",
      traceId: "tr_int",
      sessionId: "ses_int",
    };

    const { result } = renderHook(() => useYavio());

    result.current.identify("user42", { plan: "pro" });
    result.current.step("onboarding_start");
    result.current.track("button_clicked", { button: "cta" });
    result.current.conversion("signup", { value: 29.99, currency: "USD" });

    // Flush
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sentBatches).toHaveLength(1);
    const events = sentBatches[0].events;

    // Should contain auto-captured widget_render + 4 explicit events
    const types = events.map((e) => e.event_type);
    expect(types).toContain("widget_render");
    expect(types).toContain("identify");
    expect(types).toContain("step");
    expect(types).toContain("track");
    expect(types).toContain("conversion");

    // All events share the same trace/session
    for (const event of events) {
      expect(event.trace_id).toBe("tr_int");
      expect(event.session_id).toBe("ses_int");
      expect(event.source).toBe("widget");
    }

    // Auth header uses JWT (not API key)
    const [, reqOpts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = reqOpts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt_integration");
  });

  it("no-op mode: no fetch calls when config absent", async () => {
    const { result } = renderHook(() => useYavio());
    result.current.identify("user1");
    result.current.step("step1");
    result.current.track("event1");
    result.current.conversion("conv1", { value: 10, currency: "EUR" });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("window.__YAVIO__ is deleted after initialization", () => {
    window.__YAVIO__ = {
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_test",
      sessionId: "ses_test",
    };

    renderHook(() => useYavio());
    expect(window.__YAVIO__).toBeUndefined();
  });

  it("events contain valid UUIDs as event_id", async () => {
    window.__YAVIO__ = {
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_test",
      sessionId: "ses_test",
    };

    const { result } = renderHook(() => useYavio());
    result.current.track("test");

    await vi.advanceTimersByTimeAsync(5_000);

    const events = sentBatches[0].events;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const event of events) {
      expect(event.event_id).toMatch(uuidRegex);
    }
  });

  it("step_sequence starts at 1 and increments", async () => {
    window.__YAVIO__ = {
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_test",
      sessionId: "ses_test",
    };

    const { result } = renderHook(() => useYavio());
    result.current.step("a");
    result.current.step("b");

    await vi.advanceTimersByTimeAsync(5_000);

    const steps = sentBatches[0].events.filter((e) => e.event_type === "step") as Array<
      BaseEvent & { step_sequence?: number }
    >;

    expect(steps).toHaveLength(2);
    expect(steps[0].step_sequence).toBe(1);
    expect(steps[1].step_sequence).toBe(2);
  });

  it("sdk_version is included in events", async () => {
    window.__YAVIO__ = {
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_test",
      sessionId: "ses_test",
    };

    const { result } = renderHook(() => useYavio());
    result.current.track("test");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sentBatches[0].sdk_version).toBe("0.0.1");
    const trackEvent = sentBatches[0].events.find((e) => e.event_type === "track");
    expect(trackEvent?.sdk_version).toBe("0.0.1");
  });
});
