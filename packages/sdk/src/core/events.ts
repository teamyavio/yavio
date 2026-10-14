import type {
  ConnectionEvent,
  ConversionEvent,
  IdentifyEvent,
  StepEvent,
  ToolCallEvent,
  ToolDiscoveryEvent,
  TrackEvent,
} from "@yavio/shared/events";
import { generateEventId } from "./ids.js";
import { stripPii } from "./pii.js";

export interface EventContext {
  traceId: string;
  sessionId: string;
  userId?: string;
  platform?: string;
  sdkVersion: string;
}

function baseFields(ctx: EventContext, eventType: string) {
  return {
    event_id: generateEventId(),
    event_type: eventType as "identify",
    trace_id: ctx.traceId,
    session_id: ctx.sessionId,
    timestamp: new Date().toISOString(),
    source: "server" as const,
    user_id: ctx.userId,
    platform: ctx.platform,
    sdk_version: ctx.sdkVersion,
  };
}

export function buildIdentifyEvent(
  ctx: EventContext,
  userId: string,
  traits?: Record<string, unknown>,
): IdentifyEvent {
  return {
    ...baseFields(ctx, "identify"),
    event_type: "identify",
    user_id: userId,
    user_traits: traits ? stripPii(traits) : undefined,
  };
}

export function buildStepEvent(
  ctx: EventContext,
  name: string,
  sequence: number,
  meta?: Record<string, unknown>,
): StepEvent {
  return {
    ...baseFields(ctx, "step"),
    event_type: "step",
    event_name: name,
    step_sequence: sequence,
    metadata: meta ? stripPii(meta) : undefined,
  };
}

export function buildTrackEvent(
  ctx: EventContext,
  eventName: string,
  properties?: Record<string, unknown>,
): TrackEvent {
  return {
    ...baseFields(ctx, "track"),
    event_type: "track",
    event_name: eventName,
    metadata: properties ? stripPii(properties) : undefined,
  };
}

export function buildConversionEvent(
  ctx: EventContext,
  name: string,
  value: number,
  currency: string,
  meta?: Record<string, unknown>,
): ConversionEvent {
  return {
    ...baseFields(ctx, "conversion"),
    event_type: "conversion",
    event_name: name,
    conversion_value: value,
    conversion_currency: currency,
    metadata: meta ? stripPii(meta) : undefined,
  };
}

/**
 * Hard cap on the stored `error_message`. Well below the ingest field limit
 * (2 048), so the limit can never wipe the whole field. Same precedent as
 * MAX_INTENT_LENGTH in server/intent.ts.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Bounds the regex work before redaction (see normalizeIntent for the same
 * reasoning): an error message can be a handler's arbitrary text.
 */
const ERROR_MESSAGE_SAFETY_CEILING = MAX_ERROR_MESSAGE_LENGTH * 8;

/**
 * Trim, redact, clamp — in that order. Redacting before the clamp means the
 * cut never lands inside an email or card number, and the stored value is
 * genuinely <= MAX_ERROR_MESSAGE_LENGTH even though redaction tokens are longer
 * than what they replace. Returns undefined for anything unusable.
 *
 * Applied to BOTH sources of error_message — a thrown exception's message and
 * the text of an `isError: true` result. Until 0.4.0 the thrown message was the
 * one free-text field that bypassed stripPii, so
 * `Error("customer max@example.com not found")` landed verbatim.
 */
export function normalizeErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const redacted = stripPii(trimmed.slice(0, ERROR_MESSAGE_SAFETY_CEILING));
  return redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH) || undefined;
}

export type ErrorCategory =
  | "auth"
  | "validation"
  | "timeout"
  | "rate_limit"
  | "server"
  | "tool_error"
  | "unknown";

export interface ToolCallData {
  toolName: string;
  latencyMs?: number;
  status?: "success" | "error";
  /**
   * `tool_error`: the handler returned `isError: true`. `unknown`: the handler
   * threw. Server-side distinction only — the MCP SDK delivers a throw to the
   * client as an isError result too, so the model sees the same shape.
   */
  errorCategory?: ErrorCategory;
  errorMessage?: string;
  isRetry?: boolean;
  inputKeys?: Record<string, unknown>;
  inputTypes?: Record<string, unknown>;
  inputValues?: Record<string, unknown>;
  outputContent?: Record<string, unknown>;
  intentSignals?: { intent: string; source: "context_parameter" | "inferred" };
  clientMeta?: ClientMeta;
}

/**
 * Client metadata relayed by the calling platform in request `_meta`.
 * Nothing here is requested from the client — these values arrive on every
 * call whether we look at them or not (ChatGPT sends all four; other
 * platforms may send none).
 */
export interface ClientMeta {
  /** ISO 3166-1 alpha-2, from `openai/userLocation.country`. */
  countryCode?: string;
  /** BCP-47 tag, from `openai/locale`. */
  locale?: string;
  /** The end user's device/browser UA, from `openai/userAgent`. */
  endUserAgent?: string;
  /** Stable pseudonymous per-user-per-app id, from `openai/subject`. */
  subjectId?: string;
}

export function buildToolCallEvent(ctx: EventContext, data: ToolCallData): ToolCallEvent {
  return {
    ...baseFields(ctx, "tool_call"),
    event_type: "tool_call",
    event_name: data.toolName,
    latency_ms: data.latencyMs,
    status: data.status,
    error_category: data.errorCategory,
    error_message: normalizeErrorMessage(data.errorMessage),
    // Never set by the SDK today: nothing passes isRetry and ingest does not
    // derive it, so the column is always 0. Do not describe it as working.
    is_retry: data.isRetry ? 1 : 0,
    input_keys: data.inputKeys ? stripPii(data.inputKeys) : undefined,
    input_types: data.inputTypes,
    input_values: data.inputValues ? stripPii(data.inputValues) : undefined,
    output_content: data.outputContent ? stripPii(data.outputContent) : undefined,
    intent_signals: data.intentSignals ? stripPii({ ...data.intentSignals }) : undefined,
    country_code: data.clientMeta?.countryCode,
    locale: data.clientMeta?.locale,
    end_user_agent: data.clientMeta?.endUserAgent,
    subject_id: data.clientMeta?.subjectId,
  };
}

export interface ConnectionData {
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  intentEnabled?: boolean;
}

export function buildConnectionEvent(ctx: EventContext, data: ConnectionData): ConnectionEvent {
  return {
    ...baseFields(ctx, "connection"),
    event_type: "connection",
    protocol_version: data.protocolVersion,
    client_name: data.clientName,
    client_version: data.clientVersion,
    // Explicit capability beacon: lets the dashboard distinguish "intent
    // capture off" from "SDK too old to support it" (metadata absent).
    metadata: { intent_enabled: data.intentEnabled ?? false },
  };
}

export interface ToolDiscoveryData {
  toolName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export function buildToolDiscoveryEvent(
  ctx: EventContext,
  data: ToolDiscoveryData,
): ToolDiscoveryEvent {
  return {
    ...baseFields(ctx, "tool_discovery"),
    event_type: "tool_discovery",
    tool_name: data.toolName,
    description: data.description,
    input_schema: data.inputSchema,
  };
}
