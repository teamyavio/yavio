import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { IntentsContent } from "./intents-content";
import IntentsLoading from "./loading";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function IntentsPage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<IntentsLoading />}>
      <IntentsContent
        projectId={resolved.projectId}
        workspaceSlug={workspace}
        projectSlug={project}
      />
    </Suspense>
  );
}
