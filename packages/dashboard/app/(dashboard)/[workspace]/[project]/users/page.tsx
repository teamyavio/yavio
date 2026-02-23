import { resolveProject } from "@/lib/analytics/resolve-project";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import UsersLoading from "./loading";
import { UsersContent } from "./users-content";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function UsersPage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <Suspense fallback={<UsersLoading />}>
      <UsersContent projectId={resolved.projectId} />
    </Suspense>
  );
}
