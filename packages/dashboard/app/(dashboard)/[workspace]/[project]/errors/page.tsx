import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ErrorsContent } from "./errors-content";
import ErrorsLoading from "./loading";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function ErrorsPage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<ErrorsLoading />}>
      <ErrorsContent projectId={resolved.projectId} />
    </Suspense>
  );
}
