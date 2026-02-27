import { createHash } from "node:crypto";
import { nanoid } from "nanoid";

export function generateSessionId(): string {
  return `ses_${nanoid(21)}`;
}

/**
 * Derive a deterministic Yavio session ID from an external session key
 * (MCP session ID, OpenAI session, or transport session ID).
 *
 * Uses SHA-256 hash truncated to 21 base64url chars, matching the format
 * of randomly generated session IDs. This ensures the same external key
 * produces the same Yavio session ID across all server instances — no
 * shared state needed for cross-instance session correlation.
 */
export function deriveSessionId(externalId: string): string {
  const hash = createHash("sha256").update(externalId).digest("base64url");
  return `ses_${hash.substring(0, 21)}`;
}

export function generateTraceId(): string {
  return `tr_${nanoid(21)}`;
}

export function generateEventId(): string {
  return crypto.randomUUID();
}
