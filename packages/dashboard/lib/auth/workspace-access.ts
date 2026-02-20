import { getDb } from "@/lib/db";
import { workspaceMembers, workspaces } from "@yavio/db/schema";
import type { WorkspaceRole } from "@yavio/shared/validation";
import { and, eq } from "drizzle-orm";

export interface WorkspaceAccess {
  role: WorkspaceRole;
  isOwner: boolean;
}

export async function checkWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAccess | null> {
  const db = getDb();

  const rows = await db
    .select({
      role: workspaceMembers.role,
      ownerId: workspaces.ownerId,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);

  if (rows.length === 0) return null;

  return {
    role: rows[0].role as WorkspaceRole,
    isOwner: rows[0].ownerId === userId,
  };
}
