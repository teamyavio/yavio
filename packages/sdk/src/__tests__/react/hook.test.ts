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

const FULL_CONFIG = {
  token: "jwt_test",
  endpoint: "http://test/v1/events",
  traceId: "tr_test",
  sessionId: "ses_test",
};

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
  });

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
    const { result: first } = renderHook(() => useYavio(FULL_CONFIG));
    const { result: second } = renderHook(() => useYavio(FULL_CONFIG));
    expect(first.current).toBe(second.current);
  });

  it("creates events with source: widget", async () => {
    const { result } = renderHook(() => useYavio(FULL_CONFIG));
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

  it("stamps the server session's source on every widget event, auto-captured ones included (#144)", async () => {
    const { result } = renderHook(() =>
      useYavio({ _meta: { yavio: { ...FULL_CONFIG, sessionSource: "per_request" } } }),
    );
    result.current.identify("user-1");
    result.current.step("picked");
    result.current.track("note jane doe 1999");
    result.current.conversion("booked", { value: 10, currency: "EUR" });
    await vi.advanceTimersByTimeAsync(5_000);

    const events = fetchSpy.mock.calls.flatMap(
      (call) =>
        (JSON.parse((call as [string, RequestInit])[1].body as string) as { events: BaseEvent[] })
          .events,
    );
    const types = new Set(events.map((e) => e.event_type));
    for (const type of ["widget_render", "identify", "step", "track", "conversion"]) {
      expect(types.has(type as BaseEvent["event_type"])).toBe(true);
    }
    expect(new Set(events.map((e) => e.session_source))).toEqual(new Set(["per_request"]));
  });

  it("sends no session_source when the server sent none (a server before 0.5.4), or one the schema would reject", async () => {
    for (const sessionSource of [undefined, "", "x".repeat(33)]) {
      _resetWidgetInstance();
      fetchSpy.mockClear();
      const { result } = renderHook(() => useYavio({ ...FULL_CONFIG, sessionSource }));
      result.current.track("viewed");
      await vi.advanceTimersByTimeAsync(5_000);
      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
      ) as { events: BaseEvent[] };
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.every((e) => e.session_source === undefined)).toBe(true);
    }
  });

  it("identify() sets user_id on subsequent events", async () => {
    const { result } = renderHook(() => useYavio(FULL_CONFIG));
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
    const { result } = renderHook(() => useYavio(FULL_CONFIG));
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
    const { result } = renderHook(() => useYavio(FULL_CONFIG));
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
    const { result } = renderHook(() => useYavio(FULL_CONFIG));
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
    const { result } = renderHook(() => useYavio(FULL_CONFIG));
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
    renderHook(() => useYavio(FULL_CONFIG));

    await vi.advanceTimersByTimeAsync(5_000);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { events: BaseEvent[] };

    const renderEvent = body.events.find((e) => e.event_type === "widget_render");
    expect(renderEvent).toBeDefined();
    expect(renderEvent?.source).toBe("widget");
  });

  it("cleans up transport and listeners on unmount", async () => {
    const { unmount } = renderHook(() => useYavio(FULL_CONFIG));

    unmount();

    // After unmount, sending events should have no effect
    // (transport is stopped, new events won't be sent)
    fetchSpy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("upgrades from noop to active when config transitions from undefined to valid", async () => {
    // Start with no config — noop mode
    const { result } = renderHook(({ config }) => useYavio(config), {
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
    const { result: result2 } = renderHook(() => useYavio(FULL_CONFIG));

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
    const { result: activeResult } = renderHook(() => useYavio(FULL_CONFIG));
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
