import { SkeletonTable } from "@/components/analytics/skeleton-table";

export default function ToolsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
      <SkeletonTable rows={10} columns={5} />
    </div>
  );
}
