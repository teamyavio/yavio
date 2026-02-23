import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function SkeletonKPI() {
  return (
    <Card>
      <CardContent className="p-6">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-9 w-32" />
        <Skeleton className="mt-2 h-3 w-16" />
      </CardContent>
    </Card>
  );
}
