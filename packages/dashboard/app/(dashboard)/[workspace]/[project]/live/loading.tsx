import { Skeleton } from "@/components/ui/skeleton";

export default function LiveLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="h-8 w-24 animate-pulse rounded bg-muted" />
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={`live-${String(i)}`} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
