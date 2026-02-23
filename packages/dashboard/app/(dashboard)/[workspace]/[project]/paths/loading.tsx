import { Skeleton } from "@/components/ui/skeleton";

export default function PathsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="h-8 w-24 animate-pulse rounded bg-muted" />
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
