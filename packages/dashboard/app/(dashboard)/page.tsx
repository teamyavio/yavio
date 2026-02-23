import { getServerSession } from "@/lib/auth/get-session";
import { getDb } from "@/lib/db";
import { projects, workspaceMembers, workspaces } from "@yavio/db/schema";
import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

export default async function DashboardRootPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const db = getDb();

  const userWorkspaces = await db
    .select({
      slug: workspaces.slug,
      id: workspaces.id,
    })
    .from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, session.userId))
    .orderBy(asc(workspaces.createdAt))
    .limit(1);

  if (userWorkspaces.length === 0) {
    redirect("/login");
  }

  const ws = userWorkspaces[0];
  const userProjects = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.workspaceId, ws.id))
    .orderBy(asc(projects.createdAt))
    .limit(1);

  if (userProjects.length === 0) {
    redirect("/login");
  }

  redirect(`/${ws.slug}/${userProjects[0].slug}/overview`);
}
