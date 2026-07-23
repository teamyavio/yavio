import { Sidebar } from "@/components/layout/sidebar";
import { getServerSession } from "@/lib/auth/get-session";
import { getDb } from "@/lib/db";
import { projects, users, workspaceMembers, workspaces } from "@yavio/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const db = getDb();

  const [user] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  const userWorkspaces = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
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
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        workspaces={userWorkspaces}
        projects={userProjects}
        user={{ name: user?.name ?? null, email: user?.email ?? "" }}
      />
      <main className="min-w-0 flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
