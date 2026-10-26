import { IngestBatch, IngestEvent, MAX_BATCH_EVENTS } from "@yavio/shared/events";
import type { BaseEvent } from "@yavio/shared/events";

/**
 * The most per-event errors a 207 or 400 body lists: the first ones, in the
 * order found. `rejected` still counts every rejected event, so a body with
 * fewer `errors` than `rejected` was cut here. The server SDK sends at most
 * 100 events per batch, so it always gets every error.
 */
export const MAX_REPORTED_ERRORS = 100;

/** The most issues one listed error carries: the first ones zod reports. */
export const MAX_ISSUES_PER_EVENT = 10;

export interface ValidationResult {
  valid: BaseEvent[];
  /**
   * The first MAX_REPORTED_ERRORS errors, in index order, each with at most
   * MAX_ISSUES_PER_EVENT issues. Index -1: the body is not a batch.
   */
  errors: Array<{
    index: number;
    issues: string[];
  }>;
  /** Events rejected, listed in `errors` or not; 1 for a body that is not a batch. */
  rejected: number;
  /**
   * Set when the batch held more than MAX_BATCH_EVENTS events: how many it
   * held. Nothing in it was parsed, and `errors` is the one cap error.
   */
  overCap?: number;
}

/** The issue reported for a batch over the cap, worded as zod words its `too_big`. */
const BATCH_CAP_ISSUE = `events: Too big: expected array to have <=${MAX_BATCH_EVENTS} items`;

/**
 * Validate the raw request body as an IngestBatch, one event at a time, and
 * partition the events into valid and rejected.
 *
 * - A body that is not an object with a non-empty `events` array gets
 *   IngestBatch's own error, at index -1. No event is parsed for it.
 * - A batch over MAX_BATCH_EVENTS is rejected whole, before any of its
 *   events is looked at.
 * - Otherwise each event is parsed once against IngestEvent. That decides
 *   exactly what IngestBatch would (the batch schema is its events' schema
 *   plus the checks above), and an invalid event no longer rejects its batch.
 */
export function validateBatch(body: unknown): ValidationResult {
  const events =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).events
      : undefined;

  if (Array.isArray(events) && events.length > MAX_BATCH_EVENTS) {
    return {
      valid: [],
      errors: [{ index: -1, issues: [BATCH_CAP_ISSUE] }],
      rejected: events.length,
      overCap: events.length,
    };
  }

  if (!Array.isArray(events) || events.length === 0) {
    const result = IngestBatch.safeParse(body);
    if (result.success) return { valid: result.data.events, errors: [], rejected: 0 };
    return {
      valid: [],
      errors: [{ index: -1, issues: flattenZodError(result.error) }],
      rejected: 1,
    };
  }

  const valid: BaseEvent[] = [];
  const errors: ValidationResult["errors"] = [];
  let rejected = 0;

  for (let i = 0; i < events.length; i++) {
    const parsed = IngestEvent.safeParse(events[i]);
    if (parsed.success) {
      valid.push(parsed.data);
      continue;
    }
    rejected++;
    if (errors.length < MAX_REPORTED_ERRORS) {
      errors.push({ index: i, issues: flattenZodError(parsed.error) });
    }
  }

  return { valid, errors, rejected };
}

function flattenZodError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] {
  return error.issues.slice(0, MAX_ISSUES_PER_EVENT).map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}
