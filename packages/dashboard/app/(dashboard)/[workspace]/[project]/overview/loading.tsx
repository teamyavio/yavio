import { SkeletonChart } from "@/components/analytics/skeleton-chart";
import { SkeletonKPI } from "@/components/analytics/skeleton-kpi";

export default function OverviewLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid grid-cols-3 gap-4 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <SkeletonKPI key={`kpi-${String(i)}`} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SkeletonChart />
        <SkeletonChart />
      </div>
    </div>
  );
}
