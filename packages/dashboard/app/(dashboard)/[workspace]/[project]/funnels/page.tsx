import { resolveProject } from "@/lib/analytics/resolve-project";
import { Filter } from "lucide-react";
import { notFound } from "next/navigation";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
}

export default async function FunnelsPage({ params }: PageProps) {
  const { workspace, project } = await params;
  const resolved = await resolveProject(workspace, project);
  if (!resolved) notFound();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="rounded-full bg-muted p-4">
        <Filter className="h-10 w-10 text-muted-foreground" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">Funnels</h2>
      <p className="max-w-md text-center text-muted-foreground">
        Visualize step progression, calculate drop-off rates, and inspect individual user journeys.
        This view is coming soon.
      </p>
      <span className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
        Coming Soon
      </span>
    </div>
  );
}
