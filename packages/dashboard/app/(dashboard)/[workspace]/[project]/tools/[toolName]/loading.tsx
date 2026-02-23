import { SkeletonChart } from "@/components/analytics/skeleton-chart";
import { SkeletonKPI } from "@/components/analytics/skeleton-kpi";
import { SkeletonTable } from "@/components/analytics/skeleton-table";

export default function ToolDetailLoading() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-48 animate-pulse rounded bg-muted" />
      <div className="flex items-center justify-between border-b pb-4">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SkeletonKPI />
        <SkeletonKPI />
        <SkeletonKPI />
        <SkeletonKPI />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <SkeletonTable rows={10} columns={7} />
    </div>
  );
}
