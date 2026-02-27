import { describe, expect, it } from "vitest";
import {
  BaseEvent,
  ConnectionEvent,
  ConversionEvent,
  ElicitationEvent,
  EventSource,
  EventType,
  IdentifyEvent,
  IngestBatch,
  IngestEvent,
  PromptUsageEvent,
  ResourceAccessEvent,
  SamplingCallEvent,
  StepEvent,
  ToolCallEvent,
  ToolDiscoveryEvent,
  TrackEvent,
  WidgetClickEvent,
  WidgetErrorEvent,
  WidgetFocusEvent,
  WidgetFormFieldEvent,
  WidgetFormSubmitEvent,
  WidgetLinkClickEvent,
  WidgetNavigationEvent,
  WidgetPerformanceEvent,
  WidgetRageClickEvent,
  WidgetRenderEvent,
  WidgetResponseEvent,
  WidgetScrollEvent,
  WidgetVisibilityEvent,
} from "../events.js";

/** Minimal valid base event fields. */
function base(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    trace_id: "tr_abc123",
    session_id: "ses_xyz789",
    timestamp: "2025-01-15T10:30:00Z",
    source: "server" as const,
    ...overrides,
  };
}

describe("EventSource", () => {
  it("accepts 'server' and 'widget'", () => {
    expect(EventSource.parse("server")).toBe("server");
    expect(EventSource.parse("widget")).toBe("widget");
  });

  it("rejects invalid values", () => {
    expect(() => EventSource.parse("browser")).toThrow();
  });
});

describe("EventType", () => {
  it("accepts all defined event types", () => {
    const types = [
      "tool_call",
      "connection",
      "resource_access",
      "prompt_usage",
      "sampling_call",
      "elicitation",
      "widget_response",
      "tool_discovery",
      "step",
      "track",
      "conversion",
      "identify",
      "widget_render",
      "widget_error",
      "widget_visibility",
      "widget_click",
      "widget_scroll",
      "widget_form_field",
      "widget_form_submit",
      "widget_link_click",
      "widget_navigation",
      "widget_focus",
      "widget_performance",
      "widget_rage_click",
    ];
    for (const t of types) {
      expect(EventType.parse(t)).toBe(t);
    }
  });

  it("rejects unknown event types", () => {
    expect(() => EventType.parse("unknown_event")).toThrow();
  });
});

describe("BaseEvent", () => {
  it("validates a minimal base event", () => {
    const data = base({ event_type: "track" });
    const result = BaseEvent.parse(data);
    expect(result.event_id).toBe(data.event_id);
    expect(result.event_type).toBe("track");
  });

  it("accepts optional fields", () => {
    const data = base({
      event_type: "track",
      event_name: "test",
      metadata: { key: "val" },
      user_id: "user-1",
      platform: "cursor",
      sdk_version: "0.1.0",
    });
    const result = BaseEvent.parse(data);
    expect(result.event_name).toBe("test");
    expect(result.metadata).toEqual({ key: "val" });
    expect(result.user_id).toBe("user-1");
  });

  it("rejects non-UUID event_id", () => {
    expect(() => BaseEvent.parse(base({ event_type: "track", event_id: "bad" }))).toThrow();
  });

  it("rejects invalid timestamp", () => {
    expect(() =>
      BaseEvent.parse(base({ event_type: "track", timestamp: "not-a-date" })),
    ).toThrow();
  });
});

describe("ToolCallEvent", () => {
  it("validates a tool_call event", () => {
    const data = base({
      event_type: "tool_call",
      event_name: "search",
      latency_ms: 150,
      status: "success",
    });
    const result = ToolCallEvent.parse(data);
    expect(result.event_type).toBe("tool_call");
    expect(result.latency_ms).toBe(150);
    expect(result.status).toBe("success");
  });

  it("accepts error fields", () => {
    const data = base({
      event_type: "tool_call",
      event_name: "fail",
      status: "error",
      error_category: "timeout",
      error_message: "timed out",
      is_retry: 1,
    });
    const result = ToolCallEvent.parse(data);
    expect(result.error_category).toBe("timeout");
    expect(result.is_retry).toBe(1);
  });

  it("accepts token and input fields", () => {
    const data = base({
      event_type: "tool_call",
      event_name: "chat",
      tokens_in: 100,
      tokens_out: 200,
      input_keys: { query: true },
      input_types: { query: "string" },
      input_values: { query: "hello" },
      output_content: { result: "world" },
      intent_signals: { intent: "search" },
      country_code: "US",
    });
    const result = ToolCallEvent.parse(data);
    expect(result.tokens_in).toBe(100);
    expect(result.country_code).toBe("US");
  });

  it("rejects invalid country_code length", () => {
    expect(() =>
      ToolCallEvent.parse(base({ event_type: "tool_call", event_name: "x", country_code: "USA" })),
    ).toThrow();
  });

  it("rejects invalid error_category", () => {
    expect(() =>
      ToolCallEvent.parse(
        base({ event_type: "tool_call", event_name: "x", error_category: "invalid" }),
      ),
    ).toThrow();
  });
});

describe("ConnectionEvent", () => {
  it("validates with optional fields", () => {
    const data = base({
      event_type: "connection",
      protocol_version: "1.0",
      client_name: "cursor",
      client_version: "0.5.0",
      connection_duration_ms: 5000,
    });
    const result = ConnectionEvent.parse(data);
    expect(result.client_name).toBe("cursor");
  });
});

describe("ResourceAccessEvent", () => {
  it("validates a resource_access event", () => {
    const result = ResourceAccessEvent.parse(base({ event_type: "resource_access" }));
    expect(result.event_type).toBe("resource_access");
  });
});

describe("PromptUsageEvent", () => {
  it("validates a prompt_usage event", () => {
    const result = PromptUsageEvent.parse(base({ event_type: "prompt_usage" }));
    expect(result.event_type).toBe("prompt_usage");
  });
});

describe("SamplingCallEvent", () => {
  it("validates with optional fields", () => {
    const data = base({
      event_type: "sampling_call",
      latency_ms: 300,
      tokens_in: 50,
      tokens_out: 100,
    });
    const result = SamplingCallEvent.parse(data);
    expect(result.latency_ms).toBe(300);
  });
});

describe("ElicitationEvent", () => {
  it("validates with optional latency", () => {
    const result = ElicitationEvent.parse(base({ event_type: "elicitation", latency_ms: 200 }));
    expect(result.latency_ms).toBe(200);
  });
});

describe("WidgetResponseEvent", () => {
  it("validates a widget_response event", () => {
    const result = WidgetResponseEvent.parse(base({ event_type: "widget_response" }));
    expect(result.event_type).toBe("widget_response");
  });
});

describe("ToolDiscoveryEvent", () => {
  it("validates a tool_discovery event", () => {
    const data = base({
      event_type: "tool_discovery",
      tool_name: "search",
      description: "Searches the web",
      input_schema: { type: "object" },
    });
    const result = ToolDiscoveryEvent.parse(data);
    expect(result.tool_name).toBe("search");
  });

  it("rejects empty tool_name", () => {
    expect(() =>
      ToolDiscoveryEvent.parse(base({ event_type: "tool_discovery", tool_name: "" })),
    ).toThrow();
  });
});

describe("StepEvent", () => {
  it("validates with optional step_sequence", () => {
    const result = StepEvent.parse(
      base({ event_type: "step", event_name: "checkout", step_sequence: 2 }),
    );
    expect(result.step_sequence).toBe(2);
  });
});

describe("TrackEvent", () => {
  it("validates a track event", () => {
    const result = TrackEvent.parse(base({ event_type: "track", event_name: "button_click" }));
    expect(result.event_type).toBe("track");
  });
});

describe("ConversionEvent", () => {
  it("validates with conversion fields", () => {
    const data = base({
      event_type: "conversion",
      event_name: "purchase",
      conversion_value: 49.99,
      conversion_currency: "USD",
    });
    const result = ConversionEvent.parse(data);
    expect(result.conversion_value).toBe(49.99);
    expect(result.conversion_currency).toBe("USD");
  });

  it("rejects invalid currency length", () => {
    expect(() =>
      ConversionEvent.parse(
        base({ event_type: "conversion", conversion_currency: "US" }),
      ),
    ).toThrow();
  });
});

describe("IdentifyEvent", () => {
  it("validates with user_traits", () => {
    const data = base({
      event_type: "identify",
      user_traits: { name: "Alice", plan: "pro" },
    });
    const result = IdentifyEvent.parse(data);
    expect(result.user_traits).toEqual({ name: "Alice", plan: "pro" });
  });
});

describe("Widget events", () => {
  it("WidgetRenderEvent validates with device fields", () => {
    const data = base({
      event_type: "widget_render",
      source: "widget",
      viewport_width: 1920,
      viewport_height: 1080,
      device_pixel_ratio: 2,
      device_touch: 0,
      connection_type: "4g",
    });
    const result = WidgetRenderEvent.parse(data);
    expect(result.viewport_width).toBe(1920);
  });

  it("WidgetErrorEvent validates", () => {
    const result = WidgetErrorEvent.parse(base({ event_type: "widget_error", source: "widget" }));
    expect(result.event_type).toBe("widget_error");
  });

  it("WidgetVisibilityEvent validates with duration", () => {
    const result = WidgetVisibilityEvent.parse(
      base({ event_type: "widget_visibility", source: "widget", visible_duration_ms: 3000 }),
    );
    expect(result.visible_duration_ms).toBe(3000);
  });

  it("WidgetClickEvent validates with click_count", () => {
    const result = WidgetClickEvent.parse(
      base({ event_type: "widget_click", source: "widget", click_count: 2 }),
    );
    expect(result.click_count).toBe(2);
  });

  it("WidgetScrollEvent validates with scroll_depth_pct", () => {
    const result = WidgetScrollEvent.parse(
      base({ event_type: "widget_scroll", source: "widget", scroll_depth_pct: 75 }),
    );
    expect(result.scroll_depth_pct).toBe(75);
  });

  it("WidgetScrollEvent rejects out-of-range scroll_depth_pct", () => {
    expect(() =>
      WidgetScrollEvent.parse(
        base({ event_type: "widget_scroll", source: "widget", scroll_depth_pct: 150 }),
      ),
    ).toThrow();
  });

  it("WidgetFormFieldEvent validates with field_name", () => {
    const result = WidgetFormFieldEvent.parse(
      base({ event_type: "widget_form_field", source: "widget", field_name: "email" }),
    );
    expect(result.field_name).toBe("email");
  });

  it("WidgetFormSubmitEvent validates with status", () => {
    const result = WidgetFormSubmitEvent.parse(
      base({ event_type: "widget_form_submit", source: "widget", status: "success" }),
    );
    expect(result.status).toBe("success");
  });

  it("WidgetLinkClickEvent validates", () => {
    const result = WidgetLinkClickEvent.parse(
      base({ event_type: "widget_link_click", source: "widget" }),
    );
    expect(result.event_type).toBe("widget_link_click");
  });

  it("WidgetNavigationEvent validates with nav fields", () => {
    const result = WidgetNavigationEvent.parse(
      base({
        event_type: "widget_navigation",
        source: "widget",
        nav_from: "/home",
        nav_to: "/about",
      }),
    );
    expect(result.nav_from).toBe("/home");
    expect(result.nav_to).toBe("/about");
  });

  it("WidgetFocusEvent validates", () => {
    const result = WidgetFocusEvent.parse(
      base({ event_type: "widget_focus", source: "widget" }),
    );
    expect(result.event_type).toBe("widget_focus");
  });

  it("WidgetPerformanceEvent validates with load_time_ms", () => {
    const result = WidgetPerformanceEvent.parse(
      base({ event_type: "widget_performance", source: "widget", load_time_ms: 500 }),
    );
    expect(result.load_time_ms).toBe(500);
  });

  it("WidgetRageClickEvent validates", () => {
    const result = WidgetRageClickEvent.parse(
      base({ event_type: "widget_rage_click", source: "widget" }),
    );
    expect(result.event_type).toBe("widget_rage_click");
  });
});

describe("IngestEvent (discriminated union)", () => {
  it("parses a tool_call event", () => {
    const result = IngestEvent.parse(base({ event_type: "tool_call", event_name: "search" }));
    expect(result.event_type).toBe("tool_call");
  });

  it("parses a widget_render event", () => {
    const result = IngestEvent.parse(base({ event_type: "widget_render", source: "widget" }));
    expect(result.event_type).toBe("widget_render");
  });

  it("rejects unknown event_type", () => {
    expect(() => IngestEvent.parse(base({ event_type: "unknown" }))).toThrow();
  });
});

describe("IngestBatch", () => {
  it("validates a batch with one event", () => {
    const batch = IngestBatch.parse({
      events: [base({ event_type: "track", event_name: "test" })],
    });
    expect(batch.events).toHaveLength(1);
  });

  it("rejects an empty batch", () => {
    expect(() => IngestBatch.parse({ events: [] })).toThrow();
  });

  it("rejects a batch exceeding 1000 events", () => {
    const events = Array.from({ length: 1001 }, (_, i) =>
      base({
        event_type: "track",
        event_name: `event-${i}`,
        event_id: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
      }),
    );
    expect(() => IngestBatch.parse({ events })).toThrow();
  });
});
