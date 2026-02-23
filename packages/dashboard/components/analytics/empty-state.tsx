import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 py-12 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {action && (
        <Button variant="outline" onClick={action.onClick} className="mt-2">
          {action.label}
        </Button>
      )}
    </div>
  );
}
