import type { Database } from "@yavio/db/client";
import { erasureRequests, invitations, projects, users, workspaces } from "@yavio/db/schema";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Deletion with erasure (#91 part 2). Each function deletes the Postgres rows
 * AND records an erasure request in the same transaction, so a deletion can
 * no longer succeed while its ClickHouse data stays behind unnoticed: either
 * both happen or neither does. The dashboard's erasure worker then removes
 * the ClickHouse rows and retries until every table is done.
 *
 * project_ids is snapshotted here: once Postgres has cascaded the delete,
 * nothing knows a deleted workspace's projects any more, and tool_registry
 * can only be erased by project.
 */

export async function deleteProjectWithErasure(
  db: Database,
  workspaceId: string,
  projectId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .returning({ id: projects.id });
    if (!deleted) return false;
    await tx
      .insert(erasureRequests)
      .values({ scope: "project", workspaceId, projectIds: [projectId] });
    return true;
  });
}

export async function deleteWorkspaceWithErasure(db: Database, workspaceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId));
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await tx.insert(erasureRequests).values({
      scope: "workspace",
      workspaceId,
      projectIds: owned.map((p) => p.id),
    });
  });
}

/**
 * Deletes the user, their owned workspaces (each gets a request) and the
 * invitations they sent.
 *
 * Two foreign keys to users are ON DELETE no action, so deleting the user row
 * alone failed with a constraint error — for every account that owns a
 * workspace, and for anyone who ever invited someone: workspaces.owner_id and
 * invitations.invited_by. Owned workspaces are deleted explicitly (members,
 * projects, api keys and their invitations cascade from there), then the
 * remaining invitations the user sent into other workspaces.
 */
export async function deleteAccountWithErasure(db: Database, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ownedWorkspaces = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId));
    const ids = ownedWorkspaces.map((w) => w.id);
    const ownedProjects =
      ids.length > 0
        ? await tx
            .select({ id: projects.id, workspaceId: projects.workspaceId })
            .from(projects)
            .where(inArray(projects.workspaceId, ids))
        : [];

    if (ids.length > 0) {
      await tx.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    await tx.delete(invitations).where(eq(invitations.invitedBy, userId));
    await tx.delete(users).where(eq(users.id, userId));

    if (ids.length > 0) {
      await tx.insert(erasureRequests).values(
        ids.map((workspaceId) => ({
          scope: "workspace",
          workspaceId,
          projectIds: ownedProjects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id),
        })),
      );
    }
  });
}
