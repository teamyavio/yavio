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
});
export type BaseEvent = z.infer<typeof BaseEvent>;

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

export const ToolCallEvent = BaseEvent.extend({
  event_type: z.literal("tool_call"),
  latency_ms: z.number().optional(),
  status: z.enum(["success", "error"]).optional(),
  error_category: z
    .enum(["auth", "validation", "timeout", "rate_limit", "server", "unknown"])
    .optional(),
  error_message: z.string().optional(),
  is_retry: z.number().int().min(0).max(1).optional(),
  tokens_in: z.number().int().optional(),
  tokens_out: z.number().int().optional(),
});
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

export const ConnectionEvent = BaseEvent.extend({
  event_type: z.literal("connection"),
  protocol_version: z.string().optional(),
  client_name: z.string().optional(),
  client_version: z.string().optional(),
  connection_duration_ms: z.number().optional(),
});
export type ConnectionEvent = z.infer<typeof ConnectionEvent>;

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

export const StepEvent = BaseEvent.extend({
  event_type: z.literal("step"),
  step_sequence: z.number().int().optional(),
});
export type StepEvent = z.infer<typeof StepEvent>;

// ---------------------------------------------------------------------------
// track (generic custom event)
// ---------------------------------------------------------------------------

export const TrackEvent = BaseEvent.extend({
  event_type: z.literal("track"),
});
export type TrackEvent = z.infer<typeof TrackEvent>;

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

export const ConversionEvent = BaseEvent.extend({
  event_type: z.literal("conversion"),
  conversion_value: z.number().optional(),
  conversion_currency: z.string().length(3).optional(),
});
export type ConversionEvent = z.infer<typeof ConversionEvent>;

// ---------------------------------------------------------------------------
// identify
// ---------------------------------------------------------------------------

export const IdentifyEvent = BaseEvent.extend({
  event_type: z.literal("identify"),
  user_id: z.string().optional(),
  user_traits: z.record(z.unknown()).optional(),
});
export type IdentifyEvent = z.infer<typeof IdentifyEvent>;

// ---------------------------------------------------------------------------
// Batch ingestion payload (POST /v1/events)
// ---------------------------------------------------------------------------

export const IngestBatch = z.object({
  events: z.array(BaseEvent).min(1).max(1000),
});
export type IngestBatch = z.infer<typeof IngestBatch>;
