import crypto from "node:crypto";

/**
 * Generate a random invite token and its SHA-256 hash.
 * The raw token is sent to the invitee; the hash is stored in the database.
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/**
 * Hash a raw invite token for database lookup.
 */
export function hashInviteToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
