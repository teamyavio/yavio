import { validateCsrf } from "@/lib/security/csrf";
import { securityHeaders } from "@/lib/security/headers";
import { validateOrigin } from "@/lib/security/origin";
import { ErrorCode } from "@yavio/shared/error-codes";
import { type NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  // OAuth authorization endpoint: must be reachable unauthenticated so it can
  // send users through /login with the full query string preserved.
  "/oauth/authorize",
  // RFC 8414 / RFC 9728 discovery documents.
  "/.well-known",
];
// NextAuth's own routes that handle their own CSRF — exempt from our checks.
// All live under the [...nextauth] catch-all: /api/auth/<slug>
const NEXTAUTH_ROUTES = [
  "/api/auth/callback",
  "/api/auth/csrf",
  "/api/auth/error",
  "/api/auth/providers",
  "/api/auth/session",
  "/api/auth/signin",
  "/api/auth/signout",
];

// Cookieless OAuth/MCP endpoints: called by MCP clients that send no Origin
// header and no CSRF cookie. They are CSRF-immune by construction (no cookie
// auth — bearer tokens, PKCE and one-time codes only).
const CSRF_EXEMPT_ROUTES = [
  "/api/oauth/token",
  "/api/oauth/register",
  "/api/oauth/revoke",
  "/api/mcp",
];

function isNextAuthRoute(pathname: string): boolean {
  return NEXTAUTH_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

function isCsrfExemptRoute(pathname: string): boolean {
  return CSRF_EXEMPT_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next") || pathname.startsWith("/favicon") || /\.\w+$/.test(pathname)
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  const response = NextResponse.next();

  // Apply security headers
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  // Origin validation for mutating API requests
  const method = request.method;
  if (
    pathname.startsWith("/api/") &&
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS"
  ) {
    // NextAuth routes handle their own CSRF; all other API routes must pass
    // origin OR CSRF validation.
    if (!isNextAuthRoute(pathname) && !isCsrfExemptRoute(pathname)) {
      if (!validateOrigin(request) && !validateCsrf(request)) {
        return NextResponse.json(
          { error: "Origin validation failed", code: ErrorCode.DASHBOARD.ORIGIN_VALIDATION_FAILED },
          { status: 403 },
        );
      }
    }
  }

  // Auth redirect: unauthenticated users trying to access dashboard
  const sessionToken =
    request.cookies.get("authjs.session-token")?.value ??
    request.cookies.get("__Secure-authjs.session-token")?.value;

  if (
    !sessionToken &&
    !isPublicPath(pathname) &&
    !pathname.startsWith("/api/") &&
    pathname !== "/"
  ) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
