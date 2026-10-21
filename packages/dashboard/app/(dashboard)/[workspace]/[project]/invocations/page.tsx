import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InvocationsContent } from "./invocations-content";
import InvocationsLoading from "./loading";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function InvocationsPage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<InvocationsLoading />}>
      <InvocationsContent
        projectId={resolved.projectId}
        workspaceSlug={workspace}
        projectSlug={project}
      />
    </Suspense>
  );
}
