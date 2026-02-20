import type { NextRequest } from "next/server";

const CSRF_HEADER = "x-csrf-token";
const CSRF_COOKIE = "next-auth.csrf-token";
const CSRF_COOKIE_SECURE = "__Secure-next-auth.csrf-token";

/** Constant-time string comparison safe for Edge Runtime (no node:crypto). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function validateCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get(CSRF_HEADER);
  const cookieToken =
    request.cookies.get(CSRF_COOKIE)?.value ?? request.cookies.get(CSRF_COOKIE_SECURE)?.value;

  if (!headerToken || !cookieToken) return false;

  // NextAuth stores the token as "token|hash" — compare the token part
  const cookieTokenValue = cookieToken.split("|")[0];
  if (!cookieTokenValue) return false;
  return safeEqual(headerToken, cookieTokenValue);
}
