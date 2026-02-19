import type { BaseEvent } from "@yavio/shared/events";

/** Per-field byte limits. */
const LIMITS = {
  /** ID fields — reject if exceeded. */
  event_name: 256,
  user_id: 256,
  trace_id: 128,
  session_id: 128,

  /** JSON fields — truncate if exceeded. */
  metadata: 10_240, // 10 KB
  user_traits: 5_120, // 5 KB
  input_keys: 5_120, // 5 KB
  input_types: 5_120, // 5 KB
  intent_signals: 2_048, // 2 KB

  /** String fields — truncate if exceeded. */
  error_message: 2_048, // 2 KB

  /** Whole-event limit — reject if exceeded. */
  event: 51_200, // 50 KB

  /** Whole-batch limit — reject with 413 if exceeded. */
  batch: 512_000, // 500 KB
} as const;

export interface FieldLimitResult {
  accepted: BaseEvent[];
  rejected: Array<{
    index: number;
    reason: string;
  }>;
  warnings: Array<{
    index: number;
    field: string;
    warning: string;
  }>;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

/**
 * Check if the raw batch body exceeds the batch size limit (500KB).
 * Returns true if over limit.
 */
export function isBatchTooLarge(rawBody: string | Buffer): boolean {
  const len = typeof rawBody === "string" ? byteLength(rawBody) : rawBody.length;
  return len > LIMITS.batch;
}

/**
 * Enforce per-field limits on validated events.
 * - ID fields that exceed limits cause event rejection.
 * - JSON/string fields that exceed limits are truncated in place.
 */
export function enforceFieldLimits(events: BaseEvent[]): FieldLimitResult {
  const accepted: BaseEvent[] = [];
  const rejected: FieldLimitResult["rejected"] = [];
  const warnings: FieldLimitResult["warnings"] = [];

  for (let i = 0; i < events.length; i++) {
    const event = { ...events[i] };

    // Check total event size
    const eventJson = JSON.stringify(event);
    if (byteLength(eventJson) > LIMITS.event) {
      rejected.push({ index: i, reason: "Event exceeds 50KB size limit" });
      continue;
    }

    // Check ID fields (reject if exceeded)
    let shouldReject = false;
    for (const field of ["event_name", "user_id", "trace_id", "session_id"] as const) {
      const value = event[field as keyof typeof event] as string | undefined;
      if (value && value.length > LIMITS[field]) {
        rejected.push({ index: i, reason: `${field} exceeds ${LIMITS[field]} character limit` });
        shouldReject = true;
        break;
      }
    }
    if (shouldReject) continue;

    // Truncate JSON fields
    if (event.metadata) {
      const json = JSON.stringify(event.metadata);
      if (byteLength(json) > LIMITS.metadata) {
        event.metadata = { _truncated: true };
        warnings.push({ index: i, field: "metadata", warning: "Truncated: exceeded 10KB limit" });
      }
    }

    const eventRecord = event as Record<string, unknown>;

    for (const field of ["user_traits", "input_keys", "input_types", "intent_signals"] as const) {
      if (eventRecord[field]) {
        const json = JSON.stringify(eventRecord[field]);
        const limit = LIMITS[field];
        if (byteLength(json) > limit) {
          eventRecord[field] = { _truncated: true };
          const limitLabel = limit >= 1024 ? `${limit / 1024}KB` : `${limit}B`;
          warnings.push({
            index: i,
            field,
            warning: `Truncated: exceeded ${limitLabel} limit`,
          });
        }
      }
    }

    // Truncate string fields
    if (eventRecord.error_message && typeof eventRecord.error_message === "string") {
      if (byteLength(eventRecord.error_message) > LIMITS.error_message) {
        eventRecord.error_message = `${(eventRecord.error_message as string).slice(0, LIMITS.error_message - 20)}... [truncated]`;
        warnings.push({
          index: i,
          field: "error_message",
          warning: "Truncated: exceeded 2KB limit",
        });
      }
    }

    accepted.push(event);
  }

  return { accepted, rejected, warnings };
}
