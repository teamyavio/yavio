import crypto from "node:crypto";

/** ac = authorization code, at = access token, rt = refresh token. */
export type TokenKind = "ac" | "at" | "rt";

/** 256-bit opaque token with a greppable prefix. */
export function generateToken(kind: TokenKind): string {
  return `yvo_${kind}_${crypto.randomBytes(32).toString("hex")}`;
}

/**
 * Keyed hash for at-rest storage, same construction as api_keys.key_hash.
 * The HMAC key prevents offline brute-forcing if the table alone leaks.
 */
export function hashToken(raw: string): string {
  const secret = process.env.API_KEY_HASH_SECRET;
  if (!secret) {
    throw new Error("API_KEY_HASH_SECRET is not set");
  }
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) must equal the stored challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = crypto.createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(digest);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
