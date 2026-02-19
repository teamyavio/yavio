import { createHmac } from "node:crypto";

export interface JwtPayload {
  /** Project ID */
  pid: string;
  /** Workspace ID */
  wid: string;
  /** Trace ID */
  tid: string;
  /** Session ID */
  sid: string;
  /** Issued at (epoch seconds) */
  iat: number;
  /** Expires at (epoch seconds) */
  exp: number;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

const HEADER = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/**
 * Create a signed HS256 JWT with the given payload.
 */
export function jwtSign(payload: JwtPayload, secret: string): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${HEADER}.${encodedPayload}`;
  const signature = sign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

/**
 * Verify and decode an HS256 JWT.
 * Returns the payload if valid, or `null` if signature is invalid or token is expired.
 */
export function jwtVerify(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const signingInput = `${header}.${payload}`;
  const expectedSignature = sign(signingInput, secret);

  // Constant-time comparison
  if (signature.length !== expectedSignature.length) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (!a.equals(b)) return null;

  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as JwtPayload;

    // Check required claims
    if (!decoded.pid || !decoded.wid || !decoded.tid || !decoded.sid) return null;
    if (typeof decoded.exp !== "number") return null;

    // Check expiry
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;

    return decoded;
  } catch {
    return null;
  }
}
