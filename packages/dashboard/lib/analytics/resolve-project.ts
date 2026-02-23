import { getDb } from "@/lib/db";
import { projects, workspaces } from "@yavio/db/schema";
import { and, eq } from "drizzle-orm";

export interface ResolvedProject {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
}

/**
 * Resolve workspace slug + project slug into IDs.
 * Returns null if the workspace or project doesn't exist.
 */
export async function resolveProject(
  workspaceSlug: string,
  projectSlug: string,
): Promise<ResolvedProject | null> {
  const db = getDb();

  const rows = await db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceSlug: workspaces.slug,
      projectId: projects.id,
      projectName: projects.name,
      projectSlug: projects.slug,
    })
    .from(projects)
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .where(and(eq(workspaces.slug, workspaceSlug), eq(projects.slug, projectSlug)))
    .limit(1);

  if (rows.length === 0) return null;

  return rows[0];
}
