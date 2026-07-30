import { registerDcrClient } from "@/lib/oauth/clients";
import { OAuthError } from "@/lib/oauth/errors";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * RFC 7591 Dynamic Client Registration (the deprecated-but-required fallback
 * for clients without CIMD support). Public clients only.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new OAuthError("invalid_client_metadata", "request body must be JSON", 400).toResponse();
  }

  try {
    const registration = await registerDcrClient(body);
    return Response.json(
      {
        client_id: registration.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: registration.clientName ?? undefined,
        redirect_uris: registration.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: registration.applicationType ?? undefined,
      },
      { status: 201, headers: { "Cache-Control": "no-store", ...CORS_HEADERS } },
    );
  } catch (err) {
    if (err instanceof OAuthError) {
      const response = err.toResponse();
      for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
      return response;
    }
    throw err;
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
