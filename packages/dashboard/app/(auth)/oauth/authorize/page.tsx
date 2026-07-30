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
import { workspaceMembers, workspaces } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { approveConsent, denyConsent } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstValues(params: SearchParams): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
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
  const params = firstValues(await searchParams);

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

  const session = await getServerSession();
  if (!session) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, value);
    }
    redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`);
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

  const clientLabel = request.client.clientName ?? request.client.clientId;
  const redirectHost = new URL(request.redirectUri).hostname;
  const isLoopback = redirectHost === "localhost" || redirectHost === "127.0.0.1";

  return (
    <AuthCard
      title="Authorize access"
      description="An application wants to read your Yavio analytics"
    >
      <div className="space-y-4">
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">{clientLabel}</p>
          <p className="mt-1 text-muted-foreground">
            {isLoopback
              ? "Redirects to an application on your own device"
              : `Redirects to ${redirectHost}`}
          </p>
        </div>

        <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          Read-only access to analytics data of one workspace. It can never change anything, and you
          can revoke access at any time by removing the connector.
        </div>

        <form action={approveConsent} className="space-y-4">
          {Object.entries(params).map(([key, value]) =>
            value !== undefined ? <input key={key} type="hidden" name={key} value={value} /> : null,
          )}

          <div className="space-y-2">
            <Label htmlFor="workspace_id">Workspace to share</Label>
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

        <p className="text-xs text-muted-foreground">
          Signed in as {session.email}. Access is granted to this application for the selected
          workspace only.
        </p>
      </div>
    </AuthCard>
  );
}
