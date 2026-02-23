import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
import { workspaces } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { WorkspaceSettingsContent } from "./settings-content";

interface PageProps {
  params: Promise<{ workspace: string }>;
}

export default async function WorkspaceSettingsPage({ params }: PageProps) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const { workspace: workspaceSlug } = await params;

  const db = getDb();
  const [workspace] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, workspaceSlug))
    .limit(1);

  if (!workspace) notFound();

  const access = await checkWorkspaceAccess(session.userId, workspace.id);
  if (!access) notFound();

  return (
    <Suspense fallback={<div className="animate-pulse space-y-4 p-6" />}>
      <WorkspaceSettingsContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        workspaceName={workspace.name}
        userRole={access.role}
        isOwner={access.isOwner}
        userId={session.userId}
      />
    </Suspense>
  );
}
