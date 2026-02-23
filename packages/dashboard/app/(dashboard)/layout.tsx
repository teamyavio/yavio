import { Sidebar } from "@/components/layout/sidebar";
import { getServerSession } from "@/lib/auth/get-session";
import { getDb } from "@/lib/db";
import { projects, workspaceMembers, workspaces } from "@yavio/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const db = getDb();

  const userWorkspaces = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
    })
    .from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, session.userId))
    .orderBy(asc(workspaces.createdAt));

  const wsIds = userWorkspaces.map((w) => w.id);
  let userProjects: { id: string; name: string; slug: string; workspaceId: string }[] = [];
  if (wsIds.length > 0) {
    userProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        workspaceId: projects.workspaceId,
      })
      .from(projects)
      .where(inArray(projects.workspaceId, wsIds))
      .orderBy(asc(projects.createdAt));
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar workspaces={userWorkspaces} projects={userProjects} />
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
