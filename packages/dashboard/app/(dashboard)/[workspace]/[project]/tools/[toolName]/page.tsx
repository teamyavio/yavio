import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import ToolDetailLoading from "./loading";
import { ToolDetailContent } from "./tool-detail-content";

interface PageProps {
  params: Promise<{ workspace: string; project: string; toolName: string }>;
}

export default async function ToolDetailPage({ params }: PageProps) {
  const { workspace, project, toolName } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<ToolDetailLoading />}>
      <ToolDetailContent
        projectId={resolved.projectId}
        toolName={decodeURIComponent(toolName)}
        workspaceSlug={workspace}
        projectSlug={project}
      />
    </Suspense>
  );
}
