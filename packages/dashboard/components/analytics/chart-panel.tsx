"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Granularity } from "@/lib/analytics/validation";
import type { ReactNode } from "react";

interface ChartPanelProps {
  title: string;
  children: ReactNode;
  granularity?: Granularity;
  onGranularityChange?: (value: Granularity) => void;
  className?: string;
}

export function ChartPanel({
  title,
  children,
  granularity,
  onGranularityChange,
  className,
}: ChartPanelProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {granularity && onGranularityChange && (
          <ToggleGroup
            type="single"
            value={granularity}
            onValueChange={(v) => {
              if (v) onGranularityChange(v as Granularity);
            }}
            size="sm"
          >
            <ToggleGroupItem value="hour">H</ToggleGroupItem>
            <ToggleGroupItem value="day">D</ToggleGroupItem>
            <ToggleGroupItem value="week">W</ToggleGroupItem>
            <ToggleGroupItem value="month">M</ToggleGroupItem>
          </ToggleGroup>
        )}
      </CardHeader>
      <CardContent>
        <div className="min-h-64">{children}</div>
      </CardContent>
    </Card>
  );
}
