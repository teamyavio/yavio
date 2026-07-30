import { DISCOVERY_HEADERS, protectedResourceMetadata } from "@/lib/oauth/metadata";

// Path-aware RFC 9728 location for the MCP resource at /api/mcp.
export function GET(): Response {
  return Response.json(protectedResourceMetadata(), { headers: DISCOVERY_HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: DISCOVERY_HEADERS });
}
