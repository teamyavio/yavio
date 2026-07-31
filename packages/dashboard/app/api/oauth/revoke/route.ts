import { OAuthError } from "@/lib/oauth/errors";
import { revokeToken } from "@/lib/oauth/store";
import { rateLimitConfigs } from "@/lib/rate-limit/config";
import { RateLimiter } from "@/lib/rate-limit/rate-limiter";
import { clientIp } from "@/lib/security/client-ip";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const limiter = new RateLimiter(rateLimitConfigs.authOther);
limiter.start();

/**
 * RFC 7009 token revocation. Always 200 for well-formed requests, even for
 * unknown tokens — revocation must not be a probing oracle.
 */
export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);
  const limit = limiter.consume(ip);
  if (!limit.allowed) {
    return Response.json(
      { error: "slow_down", error_description: "too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)), ...CORS_HEADERS },
      },
    );
  }

  try {
    const params = new URLSearchParams(await request.text());
    const token = params.get("token");
    if (!token) {
      throw new OAuthError("invalid_request", "missing token", 400);
    }
    await revokeToken(token);
    return new Response(null, {
      status: 200,
      headers: { "Cache-Control": "no-store", ...CORS_HEADERS },
    });
  } catch (err) {
    if (err instanceof OAuthError) {
      const response = err.toResponse();
      for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
      return response;
    }
    console.error("[oauth/revoke] unexpected error:", err);
    return Response.json(
      { error: "server_error", error_description: "unexpected error" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
