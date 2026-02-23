"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { platformValues } from "@/lib/analytics/validation";
import { cn } from "@/lib/utils";
import { Filter } from "lucide-react";
import { useEffect, useState } from "react";

interface PlatformFilterProps {
  selected: string[];
  onChange: (platforms: string[]) => void;
}

export function PlatformFilter({ selected, onChange }: PlatformFilterProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const toggle = (platform: string) => {
    if (selected.includes(platform)) {
      onChange(selected.filter((p) => p !== platform));
    } else {
      onChange([...selected, platform]);
    }
  };

  if (!mounted) {
    return (
      <Button variant="outline" size="sm" className="gap-2 text-xs">
        <Filter className="h-3 w-3" />
        Platform
        {selected.length > 0 && (
          <Badge variant="secondary" className="ml-1 text-xs">
            {selected.length}
          </Badge>
        )}
      </Button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 text-xs">
          <Filter className="h-3 w-3" />
          Platform
          {selected.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-xs">
              {selected.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="end">
        <div className="space-y-1">
          {platformValues.map((platform) => (
            <button
              type="button"
              key={platform}
              className={cn(
                "flex w-full items-center rounded-md px-2 py-1.5 text-sm transition-colors",
                selected.includes(platform) ? "bg-accent text-accent-foreground" : "hover:bg-muted",
              )}
              onClick={() => toggle(platform)}
            >
              {platform}
            </button>
          ))}
          {selected.length > 0 && (
            <button
              type="button"
              className="mt-1 w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => onChange([])}
            >
              Clear all
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
