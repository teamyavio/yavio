import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReactNode } from "react";

interface ChartPanelProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function ChartPanel({ title, children, className }: ChartPanelProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="min-h-64">{children}</div>
      </CardContent>
    </Card>
  );
}
