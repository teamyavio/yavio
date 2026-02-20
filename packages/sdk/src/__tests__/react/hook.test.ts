import { renderHook } from "@testing-library/react";
import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetWidgetInstance, useYavio } from "../../react/hook.js";

function mockFetch(status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    headers: { get: () => null },
    json: () => Promise.resolve({}),
  });
}

describe("useYavio", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetWidgetInstance();
    fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.__YAVIO__ = undefined;
  });

  function setupConfig() {
    window.__YAVIO__ = {
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_test",
      sessionId: "ses_test",
    };
  }

  it("returns no-op widget when no config found", () => {
    const { result } = renderHook(() => useYavio());
    // Should not throw
    result.current.identify("user1");
    result.current.step("step1");
    result.current.track("event1");
    result.current.conversion("conv1", { value: 10, currency: "USD" });

    // No fetch calls since no-op
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns singleton on multiple calls", () => {
    setupConfig();
    const { result: first } = renderHook(() => useYavio());
    const { result: second } = renderHook(() => useYavio());
    expect(first.current).toBe(second.current);
  });

  it("creates events with source: widget", async () => {
    setupConfig();
    const { result } = renderHook(() => useYavio());
    result.current.track("test_event", { key: "value" });

    // Flush to capture the call
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { events: BaseEvent[] };

    // Find the track event (skip auto-captured widget_render)
    const trackEvent = body.events.find((e) => e.event_type === "track");
    expect(trackEvent?.source).toBe("widget");
    expect(trackEvent?.trace_id).toBe("tr_test");
    expect(trackEvent?.session_id).toBe("ses_test");
  });

  it("identify() sets user_id on subsequent events", async () => {
    setupConfig();
    const { result } = renderHook(() => useYavio());
    result.current.identify("user123", { plan: "pro" });
    result.current.track("after_identify");

    await vi.advanceTimersByTimeAsync(5_000);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { events: BaseEvent[] };

    const identifyEvent = body.events.find((e) => e.event_type === "identify");
    expect(identifyEvent?.user_id).toBe("user123");

    const trackEvent = body.events.find((e) => e.event_type === "track");
    expect(trackEvent?.user_id).toBe("user123");
  });

  it("step() auto-increments step_sequence", async () => {
    setupConfig();
    const { result } = renderHook(() => useYavio());
    result.current.step("step_a");
    result.current.step("step_b");
    result.current.step("step_c");

    await vi.advanceTimersByTimeAsync(5_000);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { events: Array<BaseEvent & { step_sequence?: number }> };

    const steps = body.events
      .filter((e) => e.event_type === "step")
      .sort((a, b) => (a.step_sequence ?? 0) - (b.step_sequence ?? 0));

    expect(steps[0].step_sequence).toBe(1);
    expect(steps[1].step_sequence).toBe(2);
    expect(steps[2].step_sequence).toBe(3);
  });

  it("conversion() includes value and currency", async () => {
    setupConfig();
    const { result } = renderHook(() => useYavio());
    result.current.conversion("purchase", { value: 49.99, currency: "EUR" });

    await vi.advanceTimersByTimeAsync(5_000);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      events: Array<BaseEvent & { conversion_value?: number; conversion_currency?: string }>;
    };

    const conv = body.events.find((e) => e.event_type === "conversion");
    expect(conv?.conversion_value).toBe(49.99);
    expect(conv?.conversion_currency).toBe("EUR");
  });

  it("strips PII from metadata", async () => {
    setupConfig();
    const { result } = renderHook(() => useYavio());
    result.current.track("contact", { email: "user@example.com", name: "John" });

    await vi.advanceTimersByTimeAsync(5_000);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { events: Array<BaseEvent & { metadata?: Record<string, unknown> }> };

    const trackEvent = body.events.find((e) => e.event_type === "track");
    expect(trackEvent?.metadata?.email).toBe("[EMAIL_REDACTED]");
    expect(trackEvent?.metadata?.name).toBe("John");
  });

  it("strips PII from identify traits", async () => {
    setupConfig();
    const { result } = renderHook(() => useYavio());
    result.current.identify("user1", { email: "test@test.com", role: "admin" });

    await vi.advanceTimersByTimeAsync(5_000);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      events: Array<BaseEvent & { user_traits?: Record<string, unknown> }>;
    };

    const identifyEvent = body.events.find((e) => e.event_type === "identify");
    expect(identifyEvent?.user_traits?.email).toBe("[EMAIL_REDACTED]");
    expect(identifyEvent?.user_traits?.role).toBe("admin");
  });

  it("emits widget_render on initialization", async () => {
    setupConfig();
    renderHook(() => useYavio());

    await vi.advanceTimersByTimeAsync(5_000);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { events: BaseEvent[] };

    const renderEvent = body.events.find((e) => e.event_type === "widget_render");
    expect(renderEvent).toBeDefined();
    expect(renderEvent?.source).toBe("widget");
  });

  it("cleans up transport and listeners on unmount", async () => {
    setupConfig();
    const { unmount } = renderHook(() => useYavio());

    unmount();

    // After unmount, sending events should have no effect
    // (transport is stopped, new events won't be sent)
    fetchSpy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("upgrades from noop to active when config transitions from undefined to valid", async () => {
    // Start with no config — noop mode
    const { result, rerender } = renderHook(({ config }) => useYavio(config), {
      initialProps: {
        config: undefined as Partial<import("../../react/types.js").WidgetConfig> | undefined,
      },
    });

    // Noop — no fetch
    result.current.track("ignored_event");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Now provide full config
    _resetWidgetInstance();
    const { result: result2 } = renderHook(() =>
      useYavio({
        token: "jwt_upgrade",
        endpoint: "http://test/v1/events",
        traceId: "tr_upgrade",
        sessionId: "ses_upgrade",
      }),
    );

    result2.current.track("active_event");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("upgrades noop singleton to active on re-render with full config", async () => {
    // Start with no config — noop
    const { result: noopResult } = renderHook(() => useYavio());
    noopResult.current.track("should_be_ignored");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Re-render with full config — should upgrade
    const fullConfig = {
      token: "jwt_lazy",
      endpoint: "http://test/v1/events",
      traceId: "tr_lazy",
      sessionId: "ses_lazy",
    };
    const { result: activeResult } = renderHook(() => useYavio(fullConfig));
    activeResult.current.track("should_be_sent");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("stays in noop when config is still partial", async () => {
    const { result } = renderHook(() => useYavio());
    result.current.track("noop_event");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Partial config — should still be noop
    const { result: result2 } = renderHook(() => useYavio({ token: "jwt_only" }));
    result2.current.track("still_noop");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
