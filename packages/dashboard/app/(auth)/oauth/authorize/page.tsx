import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { getServerSession } from "@/lib/auth/get-session";
import { getDb } from "@/lib/db";
import {
  RedirectAuthorizeError,
  RenderAuthorizeError,
  validateAuthorizeRequest,
} from "@/lib/oauth/authorize";
import { sanitizeClientName } from "@/lib/oauth/display";
import { rateLimitConfigs } from "@/lib/rate-limit/config";
import { RateLimiter } from "@/lib/rate-limit/rate-limiter";
import { clientIp } from "@/lib/security/client-ip";
import { workspaceMembers, workspaces } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { approveConsent, denyConsent } from "./actions";

export const dynamic = "force-dynamic";

const limiter = new RateLimiter(rateLimitConfigs.authOther);
limiter.start();

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Only these request params are echoed into the consent form. Everything
 * else from the URL is dropped — a stray `workspace_id` or `$ACTION_ID_*`
 * in the query string must never reach the form POST.
 */
const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;

function authorizeValues(params: SearchParams): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of AUTHORIZE_PARAMS) {
    const value = params[key];
    result[key] = Array.isArray(value) ? value[0] : value;
  }
  return result;
}

function ErrorCard({ message }: { message: string }) {
  return (
    <AuthCard
      title="Connection request stopped"
      description="This authorization request could not be processed"
    >
      <p className="text-sm text-muted-foreground">{message}</p>
    </AuthCard>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = authorizeValues(await searchParams);

  const requestHeaders = await headers();
  if (!limiter.consume(clientIp({ headers: requestHeaders })).allowed) {
    return <ErrorCard message="Too many authorization requests. Wait a moment and try again." />;
  }

  // Session first: nothing attacker-controlled (in particular no CIMD fetch)
  // runs on behalf of anonymous callers.
  const session = await getServerSession();
  if (!session) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, value);
    }
    redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`);
  }

  let request: Awaited<ReturnType<typeof validateAuthorizeRequest>>;
  try {
    request = await validateAuthorizeRequest(params);
  } catch (err) {
    if (err instanceof RenderAuthorizeError) {
      return <ErrorCard message={err.description} />;
    }
    if (err instanceof RedirectAuthorizeError) {
      redirect(err.redirectTo);
    }
    throw err;
  }

  const memberships = await getDb()
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, session.userId))
    .orderBy(workspaces.name);

  if (memberships.length === 0) {
    return (
      <ErrorCard message="Your account is not a member of any workspace, so there is nothing to share. Create a workspace first." />
    );
  }

  const clientLabel = sanitizeClientName(request.client.clientName) ?? "Unnamed application";
  const isVerifiedIdentity = request.client.registrationType === "cimd";
  const redirectHost = new URL(request.redirectUri).hostname;
  const isLoopback =
    redirectHost === "localhost" || redirectHost === "127.0.0.1" || redirectHost === "[::1]";
  // For a CIMD client the name is only as trustworthy as the domain serving
  // the identity document, so that domain is the trust signal and is always
  // shown. Hiding it when it matched the redirect host — as an earlier trim
  // did — removed it precisely in the self-hosted impersonation case, where
  // an attacker controls both.
  const identityHost = isVerifiedIdentity ? new URL(request.client.clientId).hostname : null;

  return (
    <AuthCard title="Authorize access">
      <div className="space-y-4">
        <div className="text-sm">
          <p className="font-medium">
            {clientLabel}
            {!isVerifiedIdentity && (
              <span className="ml-2 font-normal text-muted-foreground">(unverified name)</span>
            )}
          </p>
          <p className="text-muted-foreground">
            Sends data to {isLoopback ? "an app on this device" : redirectHost}
          </p>
          {identityHost !== null && (
            <p className="text-muted-foreground">Identity published by {identityHost}</p>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Read-only access to one workspace. It cannot change anything, and access ends when you
          leave the workspace.
        </p>

        <form action={approveConsent} className="space-y-4">
          {Object.entries(params).map(([key, value]) =>
            value !== undefined ? <input key={key} type="hidden" name={key} value={value} /> : null,
          )}

          <div className="space-y-2">
            <Label htmlFor="workspace_id">Workspace</Label>
            <select
              id="workspace_id"
              name="workspace_id"
              defaultValue={memberships[0].id}
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {memberships.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <Button type="submit" className="flex-1">
              Allow access
            </Button>
            <Button type="submit" formAction={denyConsent} variant="outline" className="flex-1">
              Deny
            </Button>
          </div>
        </form>

        <p className="text-xs text-muted-foreground">Signed in as {session.email}</p>
      </div>
    </AuthCard>
  );
}
