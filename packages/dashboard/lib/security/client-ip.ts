/**
 * The client address as seen by our own reverse proxy.
 *
 * X-Forwarded-For is APPENDED to by Caddy/Traefik, so the leftmost entry is
 * whatever the caller sent — attacker-controlled, and taking it let anyone
 * defeat an IP-keyed rate limit by varying the header. The rightmost entry is
 * the one our proxy added, i.e. the peer it actually accepted the connection
 * from.
 */
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  return hops[hops.length - 1] ?? "unknown";
}
