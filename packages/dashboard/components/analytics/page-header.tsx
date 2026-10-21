import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  children?: ReactNode;
  /**
   * Re-runs the page's queries with the current filters (#46). Shown as a
   * refresh button next to the filters; omitted on pages that stream.
   */
  onRefresh?: () => void;
  /** Spins the refresh icon while the queries are in flight. */
  refreshing?: boolean;
}

export function PageHeader({ title, children, onRefresh, refreshing = false }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b pb-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {(children || onRefresh) && (
        <div className="flex flex-wrap items-center gap-2">
          {children}
          {onRefresh && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh"
              title="Refresh"
              className="text-muted-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
