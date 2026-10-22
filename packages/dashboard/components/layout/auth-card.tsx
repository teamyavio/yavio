import { YavioLogo } from "@/components/layout/yavio-logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReactNode } from "react";

interface AuthCardProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        {/* The first Yavio UI a third-party user sees (OAuth consent), so
            the mark goes with the wordmark, as in the sidebar (#50). */}
        <div className="mb-2 flex items-center justify-center gap-2 text-2xl font-bold">
          <YavioLogo className="h-7 w-7" />
          <span>Yavio</span>
        </div>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
