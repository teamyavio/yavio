import { IngestBatch, IngestEvent, MAX_BATCH_EVENTS } from "@yavio/shared/events";
import type { BaseEvent } from "@yavio/shared/events";

export interface ValidationResult {
  valid: BaseEvent[];
  errors: Array<{
    index: number;
    issues: string[];
  }>;
  /**
   * Set when the batch held more than MAX_BATCH_EVENTS events: how many it
   * held. Nothing in it was parsed, and `errors` is the one cap error.
   */
  overCap?: number;
}

/** The issue reported for a batch over the cap, worded as zod words its `too_big`. */
const BATCH_CAP_ISSUE = `events: Array must contain at most ${MAX_BATCH_EVENTS} element(s)`;

/**
 * Validate the raw request body against IngestBatch, then partition
 * individual events into valid/error buckets.
 *
 * A batch over MAX_BATCH_EVENTS is rejected whole before any parsing:
 * IngestBatch's `.max()` does not keep zod 3 from parsing every element
 * first, and the per-event fallback below would parse each of them again.
 */
export function validateBatch(body: unknown): ValidationResult {
  const bodyObj = body as Record<string, unknown> | null;
  const events = bodyObj && typeof bodyObj === "object" ? bodyObj.events : undefined;
  if (Array.isArray(events) && events.length > MAX_BATCH_EVENTS) {
    return {
      valid: [],
      errors: [{ index: -1, issues: [BATCH_CAP_ISSUE] }],
      overCap: events.length,
    };
  }

  const result = IngestBatch.safeParse(body);

  if (result.success) {
    return { valid: result.data.events, errors: [] };
  }

  // If the top-level parse fails, try to validate individual events
  // for granular per-event errors. Within the cap only (checked above).
  if (!Array.isArray(events) || events.length === 0) {
    return {
      valid: [],
      errors: [{ index: -1, issues: flattenZodError(result.error) }],
    };
  }

  return validateIndividualEvents(events);
}

function validateIndividualEvents(events: unknown[]): ValidationResult {
  const valid: BaseEvent[] = [];
  const errors: ValidationResult["errors"] = [];

  for (let i = 0; i < events.length; i++) {
    const parsed = IngestEvent.safeParse(events[i]);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      errors.push({ index: i, issues: flattenZodError(parsed.error) });
    }
  }

  return { valid, errors };
}

function flattenZodError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}
