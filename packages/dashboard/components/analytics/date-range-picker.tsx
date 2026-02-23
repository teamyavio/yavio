"use client";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { DateRange } from "react-day-picker";

const PRESETS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "3m", days: 90 },
] as const;

interface DateRangePickerProps {
  from: Date;
  to: Date;
  onChange: (from: Date, to: Date) => void;
}

export function DateRangePicker({ from, to, onChange }: DateRangePickerProps) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => setMounted(true), []);

  const handlePreset = (days: number) => {
    const now = new Date();
    onChange(new Date(now.getTime() - days * 86_400_000), now);
  };

  const handleCalendarSelect = (range: DateRange | undefined) => {
    if (range?.from && range?.to) {
      onChange(range.from, range.to);
      setOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {PRESETS.map((preset) => (
        <Button
          key={preset.label}
          variant="ghost"
          size="sm"
          className={cn(
            "text-xs",
            Math.abs(to.getTime() - from.getTime() - preset.days * 86_400_000) < 3_600_000 &&
              "bg-accent",
          )}
          onClick={() => handlePreset(preset.days)}
        >
          {preset.label}
        </Button>
      ))}
      {mounted ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2 text-xs">
              <CalendarIcon className="h-3 w-3" />
              {format(from, "MMM d")} - {format(to, "MMM d")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="range"
              selected={{ from, to }}
              onSelect={handleCalendarSelect}
              numberOfMonths={2}
              disabled={{ after: new Date() }}
            />
          </PopoverContent>
        </Popover>
      ) : (
        <Button variant="outline" size="sm" className="gap-2 text-xs">
          <CalendarIcon className="h-3 w-3" />
          {format(from, "MMM d")} - {format(to, "MMM d")}
        </Button>
      )}
    </div>
  );
}
