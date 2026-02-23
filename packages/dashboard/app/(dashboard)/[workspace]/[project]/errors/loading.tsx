import { SkeletonChart } from "@/components/analytics/skeleton-chart";
import { SkeletonTable } from "@/components/analytics/skeleton-table";

export default function ErrorsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <SkeletonTable rows={10} columns={5} />
    </div>
  );
}
