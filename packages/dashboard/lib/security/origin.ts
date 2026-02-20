import type { NextRequest } from "next/server";

export function validateOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const appUrl = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000";

  try {
    const allowed = new URL(appUrl);
    const incoming = new URL(origin);
    return allowed.host === incoming.host;
  } catch {
    return false;
  }
}
