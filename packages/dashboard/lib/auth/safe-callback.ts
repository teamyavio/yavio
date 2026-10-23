/**
 * The path to navigate to after sign-in, from a user-supplied callback URL.
 *
 * The raw value is resolved against the app origin the way a browser would
 * resolve it, and it is accepted only when the result is on that same origin.
 * The return value is always a root-relative path (pathname, query and
 * fragment); anything that does not parse or leaves the origin yields the
 * fallback.
 */
export function safeCallbackPath(
  raw: string | null | undefined,
  origin: string,
  fallback = "/",
): string {
  if (!raw) return fallback;

  let base: URL;
  let resolved: URL;
  try {
    base = new URL(origin);
    resolved = new URL(raw, base);
  } catch {
    return fallback;
  }

  if (base.origin === "null" || resolved.origin !== base.origin) return fallback;

  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  // The path is navigated to as a relative reference, so it must start with
  // exactly one slash to keep resolving to this origin.
  if (!path.startsWith("/") || path.startsWith("//")) return fallback;
  return path;
}
