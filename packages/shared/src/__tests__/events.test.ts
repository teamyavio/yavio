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
  MAX_SESSION_SOURCE_LENGTH,
  PromptUsageEvent,
  ResourceAccessEvent,
  SESSION_SOURCES,
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
    expect(() => BaseEvent.parse(base({ event_type: "track", timestamp: "not-a-date" }))).toThrow();
  });

  it("carries session_source on every event type as a short string, not an enum (#144)", () => {
    for (const value of SESSION_SOURCES) {
      for (const parse of [ToolCallEvent, ConnectionEvent, TrackEvent, ToolDiscoveryEvent]) {
        const event_type = parse.shape.event_type.value;
        const extra = event_type === "tool_discovery" ? { tool_name: "x" } : {};
        const result = parse.parse(base({ event_type, session_source: value, ...extra }));
        expect(result.session_source).toBe(value);
      }
    }
    // A value this schema does not know yet (a newer SDK) still passes: ingest
    // NULLs it, an enum would have rejected the whole event.
    expect(
      IngestEvent.parse(base({ event_type: "track", session_source: "future_source" }))
        .session_source,
    ).toBe("future_source");
    expect(BaseEvent.parse(base({ event_type: "track" })).session_source).toBeUndefined();
    expect(() =>
      BaseEvent.parse(
        base({ event_type: "track", session_source: "x".repeat(MAX_SESSION_SOURCE_LENGTH + 1) }),
      ),
    ).toThrow();
    expect(() => BaseEvent.parse(base({ event_type: "track", session_source: 1 }))).toThrow();
  });

  it("lists every session source the SDK emits, each within the schema's bound", () => {
    expect([...SESSION_SOURCES]).toEqual([
      "mcp_session_id",
      "openai_session",
      "vscode_conversation",
      "codex_thread",
      "custom",
      "connection",
      "per_request",
    ]);
    expect(SESSION_SOURCES.every((s) => s.length <= MAX_SESSION_SOURCE_LENGTH)).toBe(true);
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

  // #128: a Zod failure would reject the whole event, so the schema takes any
  // string and ingest's normalizer sets a malformed one to NULL.
  it("accepts any region string, including one ingest will set to NULL", () => {
    for (const region of ["North Rhine-Westphalia", "x".repeat(500), "District 9"]) {
      const result = ToolCallEvent.parse(
        base({ event_type: "tool_call", event_name: "x", country_code: "DE", region }),
      );
      expect(result.region).toBe(region);
    }
    expect(
      ToolCallEvent.parse(base({ event_type: "tool_call", event_name: "x" })).region,
    ).toBeUndefined();
    // Not a string either: the normalizer sets it to NULL, the event is kept.
    for (const region of [null, 42, { name: "Hesse" }]) {
      expect(
        ToolCallEvent.parse(base({ event_type: "tool_call", event_name: "x", region })).region,
      ).toEqual(region);
    }
  });

  // The ingest validator is the only gate on this value: an SDK that emits a
  // category the shared enum lacks loses every such event (YAVIO-2100).
  it("accepts tool_error — the handler returned isError: true", () => {
    const result = ToolCallEvent.parse(
      base({
        event_type: "tool_call",
        event_name: "book",
        status: "error",
        error_category: "tool_error",
        error_message: "This offer reference has expired",
      }),
    );
    expect(result.error_category).toBe("tool_error");
  });

  it("accepts intent_context required/optional/none and rejects anything else", () => {
    for (const value of ["required", "optional", "none"] as const) {
      const result = ToolCallEvent.parse(
        base({ event_type: "tool_call", event_name: "refresh", intent_context: value }),
      );
      expect(result.intent_context).toBe(value);
    }
    expect(
      ToolCallEvent.parse(base({ event_type: "tool_call", event_name: "refresh" })).intent_context,
    ).toBeUndefined();
    expect(() =>
      ToolCallEvent.parse(
        base({ event_type: "tool_call", event_name: "refresh", intent_context: "widget" }),
      ),
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
      ConversionEvent.parse(base({ event_type: "conversion", conversion_currency: "US" })),
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
    const result = WidgetFocusEvent.parse(base({ event_type: "widget_focus", source: "widget" }));
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

// zod 4 is stricter than zod 3 in places, and counts string length in code
// points; ingest keeps accepting exactly what it accepted before the upgrade.
describe("zod 3 acceptance", () => {
  const accepts = (overrides: Record<string, unknown>) =>
    IngestEvent.safeParse(base({ event_type: "track", ...overrides })).success;

  it("takes UUID-shaped event ids of any version and variant", () => {
    for (const id of [
      "11111111-1111-1111-1111-111111111111",
      "00000000-0000-0000-0000-000000000001",
      "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    ]) {
      expect(accepts({ event_id: id })).toBe(true);
    }
    for (const id of [
      "550e8400e29b41d4a716446655440000",
      "{550e8400-e29b-41d4-a716-446655440000}",
    ]) {
      expect(accepts({ event_id: id })).toBe(false);
    }
  });

  it("takes a UTC timestamp without seconds, and still no offset", () => {
    expect(accepts({ timestamp: "2026-10-26T10:00Z" })).toBe(true);
    expect(accepts({ timestamp: "2026-10-26T10:00:00+02:00" })).toBe(false);
  });

  // Every number field and every bounded string of every event type, read off
  // the schemas, so a new field, or one switched back to a plain zod 4 form,
  // fails here until the tables say which rule it follows.
  describe("every number and bounded string field", () => {
    type NumberRule = "Float64" | "Float32" | "UInt16" | "UInt32" | "own bound";
    /**
     * The column's bounds on zod 3's rules (jsonNumber, jsonInt), or a bound
     * of its own (numeric-bounds.test.ts checks each field against its column).
     */
    const NUMBER_RULES: Record<string, NumberRule> = {
      latency_ms: "Float64",
      connection_duration_ms: "Float64",
      conversion_value: "Float64",
      device_pixel_ratio: "Float32",
      visible_duration_ms: "Float64",
      load_time_ms: "Float64",
      tokens_in: "UInt32",
      tokens_out: "UInt32",
      step_sequence: "UInt32",
      viewport_width: "UInt16",
      viewport_height: "UInt16",
      click_count: "UInt32",
      is_retry: "own bound",
      device_touch: "own bound",
      scroll_depth_pct: "own bound",
    };
    /** Bounds in UTF-16 code units (maxUnits, exactUnits). */
    const STRING_BOUNDS: Record<string, { max: number } | { length: number }> = {
      session_source: { max: MAX_SESSION_SOURCE_LENGTH },
      locale: { max: 35 },
      end_user_agent: { max: 512 },
      subject_id: { max: 256 },
      tool_name: { max: 256 },
      description: { max: 2048 },
      country_code: { length: 2 },
      conversion_currency: { length: 3 },
      platform: { max: 64 },
      sdk_version: { max: 64 },
      protocol_version: { max: 64 },
      client_name: { max: 256 },
      client_version: { max: 128 },
      connection_type: { max: 32 },
      field_name: { max: 256 },
      nav_from: { max: 2048 },
      nav_to: { max: 2048 },
    };

    type Def = { type: string; innerType?: { _zod: { def: Def } }; checks?: unknown[] };
    type Field = { name: string; eventType: string; field: string };
    const numberFields: Field[] = [];
    const stringFields: Field[] = [];
    for (const option of IngestEvent.options) {
      const eventType: string = option.shape.event_type.value;
      for (const [field, schema] of Object.entries(option.shape)) {
        let def = (schema as { _zod: { def: Def } })._zod.def;
        while (def.type === "optional" && def.innerType) def = def.innerType._zod.def;
        const entry = { name: `${eventType}.${field}`, eventType, field };
        // jsonNumber is a z.custom; every other number is a z.number.
        if (def.type === "number" || def.type === "custom") numberFields.push(entry);
        if (def.type === "string" && (def.checks?.length ?? 0) > 0) stringFields.push(entry);
      }
    }

    const accepts = ({ eventType, field }: Field, value: unknown) =>
      IngestEvent.safeParse(
        base({
          event_type: eventType,
          ...(eventType === "tool_discovery" ? { tool_name: "t" } : {}),
          [field]: value,
        }),
      ).success;
    const INFINITY = JSON.parse("1e999") as number;
    const MINUS_INFINITY = JSON.parse("-1e999") as number;
    /** `units` UTF-16 code units, astral characters but for an odd last one: half the code points. */
    const astral = (units: number) => "😀".repeat(Math.floor(units / 2)) + "a".repeat(units % 2);

    it("knows every number field and every bounded string the schemas declare", () => {
      expect(new Set(numberFields.map((f) => f.field))).toEqual(new Set(Object.keys(NUMBER_RULES)));
      expect(new Set(stringFields.map((f) => f.field))).toEqual(
        new Set(Object.keys(STRING_BOUNDS)),
      );
      const withRule = (rule: NumberRule) =>
        numberFields.filter((f) => NUMBER_RULES[f.field] === rule).length;
      expect(withRule("Float64") + withRule("Float32")).toBe(8);
      expect(withRule("UInt32") + withRule("UInt16")).toBe(8);
      // session_source, platform and sdk_version are on every event type.
      expect(stringFields).toHaveLength(3 * IngestEvent.options.length + 14);
    });

    it.each(numberFields.map((f) => [f.name, f] as const))(
      "%s follows its column's number rule",
      (_, f) => {
        const rule = NUMBER_RULES[f.field];
        if (rule === "Float64" || rule === "Float32") {
          // Finite: ±Infinity, what JSON.parse makes of 1e999, would be
          // serialised as null. A fraction or a negative is stored as sent.
          expect(INFINITY).toBe(Number.POSITIVE_INFINITY);
          expect(accepts(f, INFINITY)).toBe(false);
          expect(accepts(f, MINUS_INFINITY)).toBe(false);
          expect(accepts(f, 1.5)).toBe(true);
          expect(accepts(f, -2)).toBe(true);
          expect(accepts(f, Number.NaN)).toBe(false);
          expect(accepts(f, "5")).toBe(false);
          expect(accepts(f, 1e300)).toBe(rule === "Float64");
        } else if (rule === "UInt32" || rule === "UInt16") {
          const max = rule === "UInt32" ? 4_294_967_295 : 65_535;
          expect(accepts(f, 0)).toBe(true);
          expect(accepts(f, max)).toBe(true);
          expect(accepts(f, max + 1)).toBe(false);
          expect(accepts(f, -1)).toBe(false);
          expect(accepts(f, 2 ** 53)).toBe(false);
          expect(accepts(f, 1.5)).toBe(false);
          expect(accepts(f, INFINITY)).toBe(false);
        } else {
          expect(accepts(f, INFINITY)).toBe(false);
          expect(accepts(f, 2 ** 53)).toBe(false);
        }
      },
    );

    it.each(stringFields.map((f) => [f.name, f] as const))(
      "%s is bounded in UTF-16 code units",
      (_, f) => {
        const bound = STRING_BOUNDS[f.field];
        const units = "max" in bound ? bound.max : bound.length;
        expect(accepts(f, astral(units))).toBe(true);
        expect(accepts(f, `${astral(units)}a`)).toBe(false);
        if ("length" in bound) expect(accepts(f, astral(units - 1))).toBe(false);
      },
    );
  });

  it("takes records with values of any type, but not arrays", () => {
    expect(accepts({ metadata: { a: 1, b: null, c: [1], d: { e: "x" }, f: "g" } })).toBe(true);
    expect(accepts({ metadata: [] })).toBe(false);
  });
});
