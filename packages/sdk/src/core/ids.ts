import { createHash, createHmac } from "node:crypto";
import { nanoid } from "nanoid";

export function generateSessionId(): string {
  return `ses_${nanoid(21)}`;
}

/**
 * Derive a deterministic Yavio session ID from a session key a protocol or
 * client defines (Mcp-Session-Id, `openai/session`, VS Code's
 * `vscode.conversationId`, the Codex CLI's `threadId`).
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

/**
 * Derive the session ID for a key the integrator's `sessionKey` option
 * returned (#144): `ses_` + HMAC-SHA256 keyed with the API key over
 * `"custom\0" + key`, truncated like `deriveSessionId()`.
 *
 * Keyed, unlike the built-in keys: an integrator may return an email or a
 * user id, and an unkeyed hash of a guessable value is a pseudonym anyone
 * can recompute. Deterministic across processes and instances of the same
 * project; a different project (API key) gets a different id for the same
 * value, and a session splits once when the API key is rotated. The prefix
 * keeps a custom key apart from a built-in key with the same text.
 */
export function deriveCustomSessionId(apiKey: string, key: string): string {
  const hash = createHmac("sha256", apiKey).update(`custom\u0000${key}`).digest("base64url");
  return `ses_${hash.substring(0, 21)}`;
}

export function generateTraceId(): string {
  return `tr_${nanoid(21)}`;
}

export function generateEventId(): string {
  return crypto.randomUUID();
}
