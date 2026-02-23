import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LiveContent } from "./live-content";
import LiveLoading from "./loading";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function LivePage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<LiveLoading />}>
      <LiveContent projectId={resolved.projectId} />
    </Suspense>
  );
}
