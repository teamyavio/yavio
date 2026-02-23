import { Skeleton } from "@/components/ui/skeleton";

interface SkeletonTableProps {
  rows?: number;
  columns?: number;
}

export function SkeletonTable({ rows = 5, columns = 4 }: SkeletonTableProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-4">
        {Array.from({ length: columns }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton items
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton items
        <div key={i} className="flex gap-4">
          {Array.from({ length: columns }, (_, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton items
            <Skeleton key={j} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
