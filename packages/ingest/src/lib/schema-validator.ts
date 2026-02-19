import { IngestBatch, IngestEvent } from "@yavio/shared/events";
import type { BaseEvent } from "@yavio/shared/events";

export interface ValidationResult {
  valid: BaseEvent[];
  errors: Array<{
    index: number;
    issues: string[];
  }>;
}

/**
 * Validate the raw request body against IngestBatch, then partition
 * individual events into valid/error buckets.
 */
export function validateBatch(body: unknown): ValidationResult {
  const result = IngestBatch.safeParse(body);

  if (result.success) {
    return { valid: result.data.events, errors: [] };
  }

  // If the top-level parse fails, try to validate individual events
  // for granular per-event errors.
  const bodyObj = body as Record<string, unknown> | null;
  if (!bodyObj || !Array.isArray(bodyObj.events) || bodyObj.events.length === 0) {
    return {
      valid: [],
      errors: [{ index: -1, issues: flattenZodError(result.error) }],
    };
  }

  return validateIndividualEvents(bodyObj.events);
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
  issues: Array<{ path: (string | number)[]; message: string }>;
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}
