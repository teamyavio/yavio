import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import ToolsLoading from "./loading";
import { ToolsContent } from "./tools-content";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function ToolsPage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<ToolsLoading />}>
      <ToolsContent projectId={resolved.projectId} />
    </Suspense>
  );
}
