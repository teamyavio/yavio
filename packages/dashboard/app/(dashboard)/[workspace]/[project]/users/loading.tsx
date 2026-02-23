import { SkeletonChart } from "@/components/analytics/skeleton-chart";
import { SkeletonTable } from "@/components/analytics/skeleton-table";

export default function UsersLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="h-8 w-24 animate-pulse rounded bg-muted" />
      </div>
      <SkeletonTable rows={10} columns={6} />
      <SkeletonChart />
    </div>
  );
}
