import { z } from "zod";
import { IsoDatetime, Uuid } from "./validation.js";

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
// Session source (#144)
// ---------------------------------------------------------------------------

/**
 * How the server SDK derived an event's `session_id` (#144), in the SDK's
 * order of precedence:
 *
 * - `mcp_session_id`: the transport's session (`Mcp-Session-Id`);
 * - `openai_session`: ChatGPT's `_meta["openai/session"]`;
 * - `vscode_conversation`: VS Code's `_meta["vscode.conversationId"]`;
 * - `codex_thread`: `_meta.threadId` from the Codex CLI (`codex-mcp-client`);
 * - `custom`: the integrator's `sessionKey` option;
 * - `connection`: no key, a non-HTTP transport (stdio): the connection's own session;
 * - `per_request`: no key on an HTTP request, on any host; the read side does
 *   not count it as a session. Since SDK 0.5.5 every such call has a session
 *   of its own, one call, not a conversation (#169); on 0.5.4 a long-lived
 *   server reusing one stateless transport put all its key-less calls on one.
 *
 * Widget events carry their server session's source too: the server puts it
 * into the injected config (`_meta.yavio.sessionSource`) and the React SDK
 * stamps it on every event it sends.
 *
 * NULL in storage: an SDK before 0.5.4, on the server or in the widget.
 *
 * The schema takes any short string (`BaseEvent.session_source`), not this
 * enum: an enum would make an older ingest reject every event of a newer SDK
 * once a value is added. Ingest keeps the values listed here and sets any
 * other to NULL (event-normalizer.ts).
 */
export const SESSION_SOURCES = [
  "mcp_session_id",
  "openai_session",
  "vscode_conversation",
  "codex_thread",
  "custom",
  "connection",
  "per_request",
] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

/** The longest `session_source` the schema accepts. */
export const MAX_SESSION_SOURCE_LENGTH = 32;

// ---------------------------------------------------------------------------
// zod 3 acceptance
// ---------------------------------------------------------------------------

// Ingest accepts exactly the events it accepted before the zod 4 upgrade; a
// field that fails takes its whole event with it, and changing what passes
// is a decision of its own, not a side effect of the upgrade. Besides Uuid
// and IsoDatetime (validation.ts), zod 4 differs from zod 3 here in two ways:
//
// - z.number() refuses ±Infinity, which is what JSON.parse makes of an
//   overflowing literal such as 1e999, and .int() refuses integers beyond
//   ±(2^53 − 1);
// - zod 4.6 counts string bounds in Unicode code points, not in UTF-16 code
//   units (String.length) as zod 3 did: a run of emoji would pass at up to
//   twice a .max(), and .length(2) would take "😀😀" and refuse "😀".
//
// The helpers below keep zod 3's rule. Fields whose own bound already
// excludes those values (is_retry, device_touch, scroll_depth_pct, .min(1))
// keep the plain zod 4 form.

/** zod 3's `z.number()`: any number except NaN, ±Infinity included. */
const jsonNumber = () =>
  z.custom<number>(
    (v) => typeof v === "number" && !Number.isNaN(v),
    "Invalid input: expected number",
  );

/** zod 3's `z.number().int()`: any integer, beyond ±(2^53 − 1) included. */
const jsonInt = () =>
  z.number().refine(Number.isInteger, "Invalid input: expected int, received number");

/** zod 3's `z.string().max(n)`: at most `n` UTF-16 code units. */
const maxUnits = (n: number) =>
  z.string().refine((v) => v.length <= n, `Too big: expected string to have <=${n} characters`);

/** zod 3's `z.string().length(n)`: exactly `n` UTF-16 code units. */
const exactUnits = (n: number) =>
  z
    .string()
    .refine((v) => v.length === n, `Invalid input: expected string to have ${n} characters`);

// ---------------------------------------------------------------------------
// Base event (fields present on every event)
// ---------------------------------------------------------------------------

export const BaseEvent = z.object({
  event_id: Uuid,
  event_type: EventType,
  trace_id: z.string(),
  session_id: z.string(),
  timestamp: IsoDatetime,
  source: EventSource,
  event_name: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // SDK-enrichment fields (added to all events before sending)
  user_id: z.string().optional(),
  platform: z.string().optional(),
  sdk_version: z.string().optional(),
  // How the server SDK derived session_id (#144): one of SESSION_SOURCES.
  // A bounded string, not an enum, so an older ingest keeps accepting a
  // newer SDK's events; ingest NULLs a value it does not know.
  session_source: maxUnits(MAX_SESSION_SOURCE_LENGTH).optional(),
});
export type BaseEvent = z.infer<typeof BaseEvent>;

// ---------------------------------------------------------------------------
// Server auto-captured
// ---------------------------------------------------------------------------

/** tool_call — fires on every tool invocation. */
export const ToolCallEvent = BaseEvent.extend({
  event_type: z.literal("tool_call"),
  latency_ms: jsonNumber().optional(),
  status: z.enum(["success", "error"]).optional(),
  // `tool_error`: the handler returned a result with `isError: true` (MCP's
  // in-band tool failure). `unknown`: the handler threw. The client sees the
  // same shape either way — the MCP SDK converts a throw into an isError
  // result — so the distinction is server-side only.
  error_category: z
    .enum(["auth", "validation", "timeout", "rate_limit", "server", "tool_error", "unknown"])
    .optional(),
  error_message: z.string().optional(),
  is_retry: z.number().int().min(0).max(1).optional(),
  input_keys: z.record(z.string(), z.unknown()).optional(),
  input_types: z.record(z.string(), z.unknown()).optional(),
  input_values: z.record(z.string(), z.unknown()).optional(),
  output_content: z.record(z.string(), z.unknown()).optional(),
  intent_signals: z.record(z.string(), z.unknown()).optional(),
  // How the SDK advertised the intent `context` parameter for this tool (#73):
  // `required`; `optional` (widget-invoked tools, whose own iframe calls
  // cannot send it, or intent `required: false`); `none` (nothing advertised:
  // intent capture off, per-tool `intent: false`, a tool with its own
  // `context` or an unextendable schema, an unknown tool). Absent on events
  // from SDKs before 0.4.0.
  intent_context: z.enum(["required", "optional", "none"]).optional(),
  tokens_in: jsonInt().optional(),
  tokens_out: jsonInt().optional(),
  country_code: exactUnits(2).optional(),
  // State or province as the platform names it (ChatGPT: the English name in
  // openai/userLocation.region, e.g. "North Rhine-Westphalia"; not ISO
  // 3166-2). Sent with capture.geo true or "region" (#127). Any type and no
  // length or format bound on purpose: a Zod failure rejects the whole event,
  // so ingest's normalizer applies normalizeRegionName() (geo.ts) to a string
  // and sets anything else — a number, an object, a malformed name — to NULL
  // (#128).
  region: z.unknown().optional(),
  // Client metadata relayed by the platform in request _meta (ChatGPT sends
  // these on every call; other platforms may not). All optional — absence
  // means the platform did not transmit them or the SDK's capture is off.
  locale: maxUnits(35).optional(),
  end_user_agent: maxUnits(512).optional(),
  subject_id: maxUnits(256).optional(),
});
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;

/** connection — fires on transport connect and disconnect. */
export const ConnectionEvent = BaseEvent.extend({
  event_type: z.literal("connection"),
  protocol_version: z.string().optional(),
  client_name: z.string().optional(),
  client_version: z.string().optional(),
  connection_duration_ms: jsonNumber().optional(),
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
  latency_ms: jsonNumber().optional(),
  tokens_in: jsonInt().optional(),
  tokens_out: jsonInt().optional(),
});
export type SamplingCallEvent = z.infer<typeof SamplingCallEvent>;

/** elicitation — fires on elicitation/requestInput interception. */
export const ElicitationEvent = BaseEvent.extend({
  event_type: z.literal("elicitation"),
  latency_ms: jsonNumber().optional(),
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
  tool_name: maxUnits(256).min(1),
  description: maxUnits(2048).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});
export type ToolDiscoveryEvent = z.infer<typeof ToolDiscoveryEvent>;

// ---------------------------------------------------------------------------
// Explicit (server + widget)
// ---------------------------------------------------------------------------

/** step — funnel progression point. */
export const StepEvent = BaseEvent.extend({
  event_type: z.literal("step"),
  step_sequence: jsonInt().optional(),
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
  conversion_value: jsonNumber().optional(),
  conversion_currency: exactUnits(3).optional(),
});
export type ConversionEvent = z.infer<typeof ConversionEvent>;

/** identify — user identification event. */
export const IdentifyEvent = BaseEvent.extend({
  event_type: z.literal("identify"),
  user_traits: z.record(z.string(), z.unknown()).optional(),
});
export type IdentifyEvent = z.infer<typeof IdentifyEvent>;

// ---------------------------------------------------------------------------
// Widget auto-captured
// ---------------------------------------------------------------------------

/** widget_render — fires once on useYavio() first initialization. */
export const WidgetRenderEvent = BaseEvent.extend({
  event_type: z.literal("widget_render"),
  viewport_width: jsonInt().optional(),
  viewport_height: jsonInt().optional(),
  device_pixel_ratio: jsonNumber().optional(),
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
  visible_duration_ms: jsonNumber().optional(),
});
export type WidgetVisibilityEvent = z.infer<typeof WidgetVisibilityEvent>;

/** widget_click — fires on every click/tap event. */
export const WidgetClickEvent = BaseEvent.extend({
  event_type: z.literal("widget_click"),
  click_count: jsonInt().optional(),
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
  load_time_ms: jsonNumber().optional(),
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

/** The most events one POST /v1/events batch may hold; ingest rejects a longer batch whole. */
export const MAX_BATCH_EVENTS = 1000;

export const IngestBatch = z.object({
  events: z.array(IngestEvent).min(1).max(MAX_BATCH_EVENTS),
});
export type IngestBatch = z.infer<typeof IngestBatch>;
