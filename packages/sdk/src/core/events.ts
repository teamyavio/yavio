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

export interface ToolCallData {
  toolName: string;
  latencyMs?: number;
  status?: "success" | "error";
  errorCategory?: "auth" | "validation" | "timeout" | "rate_limit" | "server" | "unknown";
  errorMessage?: string;
  isRetry?: boolean;
  inputKeys?: Record<string, unknown>;
  inputTypes?: Record<string, unknown>;
}

export function buildToolCallEvent(ctx: EventContext, data: ToolCallData): ToolCallEvent {
  return {
    ...baseFields(ctx, "tool_call"),
    event_type: "tool_call",
    event_name: data.toolName,
    latency_ms: data.latencyMs,
    status: data.status,
    error_category: data.errorCategory,
    error_message: data.errorMessage,
    is_retry: data.isRetry ? 1 : 0,
    input_keys: data.inputKeys ? stripPii(data.inputKeys) : undefined,
    input_types: data.inputTypes,
  };
}

export interface ConnectionData {
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
}

export function buildConnectionEvent(ctx: EventContext, data: ConnectionData): ConnectionEvent {
  return {
    ...baseFields(ctx, "connection"),
    event_type: "connection",
    protocol_version: data.protocolVersion,
    client_name: data.clientName,
    client_version: data.clientVersion,
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
