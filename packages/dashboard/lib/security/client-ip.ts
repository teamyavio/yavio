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
  const hops = (forwarded ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  if (hops.length > 0) return hops[hops.length - 1];

  // No XFF at all — a self-hosted install with no reverse proxy, which
  // docker-compose ships. Collapsing everyone into one "unknown" bucket would
  // rate-limit the whole instance as a single caller, so fall back to any
  // other per-client signal before doing that.
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  return "unknown";
}
