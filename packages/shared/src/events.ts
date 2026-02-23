import { z } from "zod";

// ---------------------------------------------------------------------------
// Event source & platform
// ---------------------------------------------------------------------------

export const EventSource = z.enum(["server", "widget"]);
export type EventSource = z.infer<typeof EventSource>;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** All recognised event type strings. */
export const EventType = z.enum([
  // Server auto-captured
  "tool_call",
  "connection",
  "resource_access",
  "prompt_usage",
  "sampling_call",
  "elicitation",
  "widget_response",
  "tool_discovery",

  // Explicit (server + widget)
  "step",
  "track",
  "conversion",
  "identify",

  // Widget auto-captured
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
]);
export type EventType = z.infer<typeof EventType>;

// ---------------------------------------------------------------------------
// Base event (fields present on every event)
// ---------------------------------------------------------------------------

export const BaseEvent = z.object({
  event_id: z.string().uuid(),
  event_type: EventType,
  trace_id: z.string(),
  session_id: z.string(),
  timestamp: z.string().datetime(),
  source: EventSource,
  event_name: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  // SDK-enrichment fields (added to all events before sending)
  user_id: z.string().optional(),
  platform: z.string().optional(),
  sdk_version: z.string().optional(),
});
export type BaseEvent = z.infer<typeof BaseEvent>;

// ---------------------------------------------------------------------------
// Server auto-captured
// ---------------------------------------------------------------------------

/** tool_call — fires on every tool invocation. */
export const ToolCallEvent = BaseEvent.extend({
  event_type: z.literal("tool_call"),
  latency_ms: z.number().optional(),
  status: z.enum(["success", "error"]).optional(),
  error_category: z
    .enum(["auth", "validation", "timeout", "rate_limit", "server", "unknown"])
    .optional(),
  error_message: z.string().optional(),
  is_retry: z.number().int().min(0).max(1).optional(),
  input_keys: z.record(z.unknown()).optional(),
  input_types: z.record(z.unknown()).optional(),
  input_values: z.record(z.unknown()).optional(),
  output_content: z.record(z.unknown()).optional(),
  intent_signals: z.record(z.unknown()).optional(),
  tokens_in: z.number().int().optional(),
  tokens_out: z.number().int().optional(),
  country_code: z.string().length(2).optional(),
});
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;

/** connection — fires on transport connect and disconnect. */
export const ConnectionEvent = BaseEvent.extend({
  event_type: z.literal("connection"),
  protocol_version: z.string().optional(),
  client_name: z.string().optional(),
  client_version: z.string().optional(),
  connection_duration_ms: z.number().optional(),
});
export type ConnectionEvent = z.infer<typeof ConnectionEvent>;

/** resource_access — fires on resources/read and resources/list interception. */
export const ResourceAccessEvent = BaseEvent.extend({
  event_type: z.literal("resource_access"),
});
export type ResourceAccessEvent = z.infer<typeof ResourceAccessEvent>;

/** prompt_usage — fires on prompts/list and prompts/get interception. */
export const PromptUsageEvent = BaseEvent.extend({
  event_type: z.literal("prompt_usage"),
});
export type PromptUsageEvent = z.infer<typeof PromptUsageEvent>;

/** sampling_call — fires on sampling/createMessage interception. */
export const SamplingCallEvent = BaseEvent.extend({
  event_type: z.literal("sampling_call"),
  latency_ms: z.number().optional(),
  tokens_in: z.number().int().optional(),
  tokens_out: z.number().int().optional(),
});
export type SamplingCallEvent = z.infer<typeof SamplingCallEvent>;

/** elicitation — fires on elicitation/requestInput interception. */
export const ElicitationEvent = BaseEvent.extend({
  event_type: z.literal("elicitation"),
  latency_ms: z.number().optional(),
});
export type ElicitationEvent = z.infer<typeof ElicitationEvent>;

/** widget_response — fires when proxy detects a widget response in tool return. */
export const WidgetResponseEvent = BaseEvent.extend({
  event_type: z.literal("widget_response"),
});
export type WidgetResponseEvent = z.infer<typeof WidgetResponseEvent>;

/** tool_discovery — fires when a tool is registered on the server. */
export const ToolDiscoveryEvent = BaseEvent.extend({
  event_type: z.literal("tool_discovery"),
  tool_name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  input_schema: z.record(z.unknown()).optional(),
});
export type ToolDiscoveryEvent = z.infer<typeof ToolDiscoveryEvent>;

// ---------------------------------------------------------------------------
// Explicit (server + widget)
// ---------------------------------------------------------------------------

/** step — funnel progression point. */
export const StepEvent = BaseEvent.extend({
  event_type: z.literal("step"),
  step_sequence: z.number().int().optional(),
});
export type StepEvent = z.infer<typeof StepEvent>;

/** track — generic custom event. */
export const TrackEvent = BaseEvent.extend({
  event_type: z.literal("track"),
});
export type TrackEvent = z.infer<typeof TrackEvent>;

/** conversion — revenue attribution event. */
export const ConversionEvent = BaseEvent.extend({
  event_type: z.literal("conversion"),
  conversion_value: z.number().optional(),
  conversion_currency: z.string().length(3).optional(),
});
export type ConversionEvent = z.infer<typeof ConversionEvent>;

/** identify — user identification event. */
export const IdentifyEvent = BaseEvent.extend({
  event_type: z.literal("identify"),
  user_traits: z.record(z.unknown()).optional(),
});
export type IdentifyEvent = z.infer<typeof IdentifyEvent>;

// ---------------------------------------------------------------------------
// Widget auto-captured
// ---------------------------------------------------------------------------

/** widget_render — fires once on useYavio() first initialization. */
export const WidgetRenderEvent = BaseEvent.extend({
  event_type: z.literal("widget_render"),
  viewport_width: z.number().int().optional(),
  viewport_height: z.number().int().optional(),
  device_pixel_ratio: z.number().optional(),
  device_touch: z.number().int().min(0).max(1).optional(),
  connection_type: z.string().optional(),
});
export type WidgetRenderEvent = z.infer<typeof WidgetRenderEvent>;

/** widget_error — fires on unhandled JS error or promise rejection. */
export const WidgetErrorEvent = BaseEvent.extend({
  event_type: z.literal("widget_error"),
});
export type WidgetErrorEvent = z.infer<typeof WidgetErrorEvent>;

/** widget_visibility — fires when widget enters or exits viewport. */
export const WidgetVisibilityEvent = BaseEvent.extend({
  event_type: z.literal("widget_visibility"),
  visible_duration_ms: z.number().optional(),
});
export type WidgetVisibilityEvent = z.infer<typeof WidgetVisibilityEvent>;

/** widget_click — fires on every click/tap event. */
export const WidgetClickEvent = BaseEvent.extend({
  event_type: z.literal("widget_click"),
  click_count: z.number().int().optional(),
});
export type WidgetClickEvent = z.infer<typeof WidgetClickEvent>;

/** widget_scroll — fires on scroll events within widget container. */
export const WidgetScrollEvent = BaseEvent.extend({
  event_type: z.literal("widget_scroll"),
  scroll_depth_pct: z.number().min(0).max(100).optional(),
});
export type WidgetScrollEvent = z.infer<typeof WidgetScrollEvent>;

/** widget_form_field — fires on focus and blur of form inputs. */
export const WidgetFormFieldEvent = BaseEvent.extend({
  event_type: z.literal("widget_form_field"),
  field_name: z.string().optional(),
});
export type WidgetFormFieldEvent = z.infer<typeof WidgetFormFieldEvent>;

/** widget_form_submit — fires on form submission attempt. */
export const WidgetFormSubmitEvent = BaseEvent.extend({
  event_type: z.literal("widget_form_submit"),
  status: z.enum(["success", "error"]).optional(),
});
export type WidgetFormSubmitEvent = z.infer<typeof WidgetFormSubmitEvent>;

/** widget_link_click — fires on click of anchor or external link. */
export const WidgetLinkClickEvent = BaseEvent.extend({
  event_type: z.literal("widget_link_click"),
});
export type WidgetLinkClickEvent = z.infer<typeof WidgetLinkClickEvent>;

/** widget_navigation — fires on view/route change within multi-step widget. */
export const WidgetNavigationEvent = BaseEvent.extend({
  event_type: z.literal("widget_navigation"),
  nav_from: z.string().optional(),
  nav_to: z.string().optional(),
});
export type WidgetNavigationEvent = z.infer<typeof WidgetNavigationEvent>;

/** widget_focus — fires when widget iframe gains or loses focus. */
export const WidgetFocusEvent = BaseEvent.extend({
  event_type: z.literal("widget_focus"),
});
export type WidgetFocusEvent = z.infer<typeof WidgetFocusEvent>;

/** widget_performance — fires via PerformanceObserver on widget load. */
export const WidgetPerformanceEvent = BaseEvent.extend({
  event_type: z.literal("widget_performance"),
  load_time_ms: z.number().optional(),
});
export type WidgetPerformanceEvent = z.infer<typeof WidgetPerformanceEvent>;

/** widget_rage_click — fires when 3+ clicks occur within 500ms on same element. */
export const WidgetRageClickEvent = BaseEvent.extend({
  event_type: z.literal("widget_rage_click"),
});
export type WidgetRageClickEvent = z.infer<typeof WidgetRageClickEvent>;

// ---------------------------------------------------------------------------
// Discriminated union of all event types
// ---------------------------------------------------------------------------

/** Any valid event for ingestion, validated per event_type. */
export const IngestEvent = z.discriminatedUnion("event_type", [
  // Server auto-captured
  ToolCallEvent,
  ConnectionEvent,
  ResourceAccessEvent,
  PromptUsageEvent,
  SamplingCallEvent,
  ElicitationEvent,
  WidgetResponseEvent,
  ToolDiscoveryEvent,
  // Explicit (server + widget)
  StepEvent,
  TrackEvent,
  ConversionEvent,
  IdentifyEvent,
  // Widget auto-captured
  WidgetRenderEvent,
  WidgetErrorEvent,
  WidgetVisibilityEvent,
  WidgetClickEvent,
  WidgetScrollEvent,
  WidgetFormFieldEvent,
  WidgetFormSubmitEvent,
  WidgetLinkClickEvent,
  WidgetNavigationEvent,
  WidgetFocusEvent,
  WidgetPerformanceEvent,
  WidgetRageClickEvent,
]);
export type IngestEvent = z.infer<typeof IngestEvent>;

// ---------------------------------------------------------------------------
// Batch ingestion payload (POST /v1/events)
// ---------------------------------------------------------------------------

export const IngestBatch = z.object({
  events: z.array(IngestEvent).min(1).max(1000),
});
export type IngestBatch = z.infer<typeof IngestBatch>;
