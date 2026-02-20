import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAutoCapture } from "../../react/auto-capture.js";
import type { WidgetConfig } from "../../react/types.js";

function mockConfig(): WidgetConfig {
  return {
    token: "jwt_test",
    endpoint: "http://test/v1/events",
    traceId: "tr_test",
    sessionId: "ses_test",
  };
}

describe("initAutoCapture", () => {
  let captured: BaseEvent[];
  let enqueue: (events: BaseEvent[]) => void;
  let cleanup: () => void;

  beforeEach(() => {
    captured = [];
    enqueue = (events) => captured.push(...events);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("emits widget_render on initialization", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);
    const render = captured.find((e) => e.event_type === "widget_render");
    expect(render).toBeDefined();
    expect(render?.source).toBe("widget");
    expect(render?.trace_id).toBe("tr_test");
  });

  it("widget_render includes viewport metadata", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);
    const render = captured.find((e) => e.event_type === "widget_render");
    const meta = render?.metadata as Record<string, unknown>;
    expect(meta.viewport_width).toBeDefined();
    expect(meta.viewport_height).toBeDefined();
    expect(meta.device_pixel_ratio).toBeDefined();
    expect(meta.timezone).toBeDefined();
  });

  it("emits widget_click on click", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);
    const button = document.createElement("button");
    button.id = "test-btn";
    document.body.appendChild(button);

    button.click();

    const click = captured.find((e) => e.event_type === "widget_click");
    expect(click).toBeDefined();
    const meta = click?.metadata as Record<string, unknown>;
    expect(meta.target_tag).toBe("button");
    expect(meta.target_id).toBe("test-btn");

    document.body.removeChild(button);
  });

  it("emits widget_error on window error", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    const errorEvent = new ErrorEvent("error", {
      message: "Test error",
      filename: "test.js",
      error: new Error("Test error"),
    });
    window.dispatchEvent(errorEvent);

    const error = captured.find((e) => e.event_type === "widget_error");
    expect(error).toBeDefined();
    const meta = error?.metadata as Record<string, unknown>;
    expect(meta.error_message).toBe("Test error");
  });

  it("emits widget_error on unhandled rejection", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    const event = new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(),
      reason: new Error("Rejected!"),
    });
    window.dispatchEvent(event);

    const error = captured.find(
      (e) =>
        e.event_type === "widget_error" &&
        (e.metadata as Record<string, unknown>)?.error_source === "unhandledrejection",
    );
    expect(error).toBeDefined();
    const meta = error?.metadata as Record<string, unknown>;
    expect(meta.error_message).toBe("Rejected!");
  });

  it("emits widget_form_field on focus/blur", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    const input = document.createElement("input");
    input.name = "email";
    input.type = "email";
    document.body.appendChild(input);

    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    const field = captured.find((e) => e.event_type === "widget_form_field");
    expect(field).toBeDefined();
    const meta = field?.metadata as Record<string, unknown>;
    expect(meta.field_name).toBe("email");
    expect(meta.field_type).toBe("email");
    expect(typeof meta.time_in_field_ms).toBe("number");

    document.body.removeChild(input);
  });

  it("emits widget_form_submit on form submission", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    const form = document.createElement("form");
    form.id = "test-form";
    document.body.appendChild(form);

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));

    const submit = captured.find((e) => e.event_type === "widget_form_submit");
    expect(submit).toBeDefined();
    const meta = submit?.metadata as Record<string, unknown>;
    expect(meta.form_id).toBe("test-form");

    document.body.removeChild(form);
  });

  it("emits widget_link_click on anchor click", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    const link = document.createElement("a");
    link.href = "https://external.com/page";
    link.textContent = "External";
    document.body.appendChild(link);

    link.click();

    const linkClick = captured.find((e) => e.event_type === "widget_link_click");
    expect(linkClick).toBeDefined();
    const meta = linkClick?.metadata as Record<string, unknown>;
    expect(meta.href).toBe("https://external.com/page");
    expect(meta.link_text).toBe("External");
    expect(meta.is_external).toBe(true);

    document.body.removeChild(link);
  });

  it("emits widget_focus on window blur", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    window.dispatchEvent(new FocusEvent("focus"));
    window.dispatchEvent(new FocusEvent("blur"));

    const focus = captured.find((e) => e.event_type === "widget_focus");
    expect(focus).toBeDefined();
    const meta = focus?.metadata as Record<string, unknown>;
    expect(meta.focus_count).toBe(1);
    expect(typeof meta.focus_duration_ms).toBe("number");
  });

  it("emits widget_rage_click on 3+ rapid clicks", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    const button = document.createElement("button");
    button.id = "rage-btn";
    document.body.appendChild(button);

    // 3 rapid clicks on same element
    button.click();
    button.click();
    button.click();

    const rageClick = captured.find((e) => e.event_type === "widget_rage_click");
    expect(rageClick).toBeDefined();
    const meta = rageClick?.metadata as Record<string, unknown>;
    expect(meta.target_id).toBe("rage-btn");
    expect((meta.click_count as number) >= 3).toBe(true);

    document.body.removeChild(button);
  });

  it("cleanup removes all listeners", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);
    const initialCount = captured.length;

    cleanup();

    // Click after cleanup should not emit events
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.click();

    const newClicks = captured.slice(initialCount).filter((e) => e.event_type === "widget_click");
    expect(newClicks).toHaveLength(0);

    document.body.removeChild(button);
  });

  it("emits widget_navigation on popstate", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    // Simulate navigation
    window.history.pushState({}, "", "/new-path");

    const nav = captured.find((e) => e.event_type === "widget_navigation");
    expect(nav).toBeDefined();
    const meta = nav?.metadata as Record<string, unknown>;
    expect(meta.to_view).toContain("/new-path");
  });

  it("reports scroll direction based on delta, not absolute position", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    vi.useFakeTimers();

    // Simulate scrolling down
    Object.defineProperty(window, "scrollY", { value: 100, writable: true, configurable: true });
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(250);

    const downScroll = captured.find((e) => e.event_type === "widget_scroll");
    expect(downScroll).toBeDefined();
    expect((downScroll?.metadata as Record<string, unknown>).scroll_direction).toBe("down");

    // Simulate scrolling back up (scrollY decreases)
    Object.defineProperty(window, "scrollY", { value: 50, writable: true, configurable: true });
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(250);

    const scrollEvents = captured.filter((e) => e.event_type === "widget_scroll");
    const upScroll = scrollEvents[scrollEvents.length - 1];
    expect((upScroll?.metadata as Record<string, unknown>).scroll_direction).toBe("up");

    vi.useRealTimers();
  });

  it("widget_form_submit includes validation_errors count", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    const form = document.createElement("form");
    form.id = "validated-form";

    // Add a required but empty input (invalid)
    const input = document.createElement("input");
    input.type = "text";
    input.required = true;
    input.name = "required_field";
    form.appendChild(input);

    // Add a valid input
    const valid = document.createElement("input");
    valid.type = "text";
    valid.name = "optional_field";
    valid.value = "filled";
    form.appendChild(valid);

    document.body.appendChild(form);

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));

    const submit = captured.find((e) => e.event_type === "widget_form_submit");
    expect(submit).toBeDefined();
    const meta = submit?.metadata as Record<string, unknown>;
    expect(meta.validation_errors).toBe(1);

    document.body.removeChild(form);
  });

  it("preserves third-party history patches on cleanup", () => {
    cleanup = initAutoCapture(mockConfig(), enqueue);

    // Simulate a third-party library patching after us
    const thirdPartyPush = vi.fn();
    history.pushState = thirdPartyPush;

    // Our cleanup should NOT overwrite the third-party patch
    cleanup();

    expect(history.pushState).toBe(thirdPartyPush);
  });
});
