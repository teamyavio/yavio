import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface ErrorAlertProps {
  message: string;
  retry?: () => void;
}

export function ErrorAlert({ message, retry }: ErrorAlertProps) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 py-12 text-center">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <h3 className="text-lg font-semibold">Something went wrong</h3>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {retry && (
        <Button variant="outline" onClick={retry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  );
}
