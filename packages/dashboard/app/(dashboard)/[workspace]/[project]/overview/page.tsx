import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import OverviewLoading from "./loading";
import { OverviewContent } from "./overview-content";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function OverviewPage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<OverviewLoading />}>
      <OverviewContent projectId={resolved.projectId} />
    </Suspense>
  );
}
