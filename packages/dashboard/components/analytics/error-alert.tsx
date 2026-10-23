"use client";

import { Button } from "@/components/ui/button";
import { isRetryableError, needsSignIn } from "@/lib/analytics/request";
import { AlertTriangle } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";

interface ErrorAlertProps {
  error: Error;
  /** Offered as "Try again" only when repeating the request can succeed. */
  retry?: () => void;
}

export function ErrorAlert({ error, retry }: ErrorAlertProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // A query that timed out, was rejected or needs more memory than allowed
  // fails the same way again; its message says what to change instead (#159).
  const canRetry = retry !== undefined && isRetryableError(error);
  // An expired session: back to this page, filters included, once signed in.
  const query = searchParams.toString();
  const signInHref = needsSignIn(error)
    ? `/login?callbackUrl=${encodeURIComponent(query ? `${pathname}?${query}` : pathname)}`
    : undefined;

  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 py-12 text-center">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <h3 className="text-lg font-semibold">Something went wrong</h3>
      <p className="max-w-md text-sm text-muted-foreground">{error.message}</p>
      {canRetry && (
        <Button variant="outline" onClick={retry} className="mt-2">
          Try again
        </Button>
      )}
      {signInHref && (
        <Button asChild variant="outline" className="mt-2">
          <a href={signInHref}>Sign in again</a>
        </Button>
      )}
    </div>
  );
}
