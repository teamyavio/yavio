import { getDb } from "@/lib/db";
import { projects } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { McpToolError } from "./errors";

export interface AuthorizedProject {
  id: string;
  name: string;
  slug: string;
}

/**
 * The ownership boundary every project-scoped tool goes through: the project
 * must exist AND belong to the token's workspace. Both failure modes return
 * the same message so other workspaces' project ids are not probeable.
 */
export async function requireProjectInWorkspace(
  workspaceId: string,
  projectId: string,
): Promise<AuthorizedProject> {
  const rows = await getDb()
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      workspaceId: projects.workspaceId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (rows.length === 0 || rows[0].workspaceId !== workspaceId) {
    throw new McpToolError(
      "Unknown project_id for this workspace. Call list_projects to see the projects you can query.",
    );
  }
  return { id: rows[0].id, name: rows[0].name, slug: rows[0].slug };
}
