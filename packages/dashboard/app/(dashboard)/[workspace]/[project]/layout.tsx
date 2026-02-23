import { resolveProject } from "@/lib/analytics/resolve-project";
import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

interface LayoutProps {
  children: ReactNode;
  params: Promise<{ workspace: string; project: string }>;
}

export default async function ProjectLayout({ children, params }: LayoutProps) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);

  if (!resolved) notFound();

  const access = await checkWorkspaceAccess(session.userId, resolved.workspaceId);
  if (!access) notFound();

  return <>{children}</>;
}
