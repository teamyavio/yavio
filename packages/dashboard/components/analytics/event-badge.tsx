"use client";

import { Badge } from "@/components/ui/badge";
import { EVENT_TYPE_COLORS } from "./chart-config";

interface EventBadgeProps {
  eventType: string;
}

export function EventBadge({ eventType }: EventBadgeProps) {
  const color = EVENT_TYPE_COLORS[eventType] ?? "#737373";

  return (
    <Badge
      variant="outline"
      className="font-mono text-xs"
      style={{ borderLeftWidth: 3, borderLeftColor: color }}
    >
      {eventType}
    </Badge>
  );
}
