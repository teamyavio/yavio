import { DISCOVERY_HEADERS, authorizationServerMetadata } from "@/lib/oauth/metadata";

export function GET(): Response {
  return Response.json(authorizationServerMetadata(), { headers: DISCOVERY_HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: DISCOVERY_HEADERS });
}
