import { DISCOVERY_HEADERS, protectedResourceMetadata } from "@/lib/oauth/metadata";

// Root fallback: some clients probe here before the path-aware location.
export function GET(): Response {
  return Response.json(protectedResourceMetadata(), { headers: DISCOVERY_HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: DISCOVERY_HEADERS });
}
