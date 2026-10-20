"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCountry, formatPercent } from "@/lib/analytics/format";
import type { LocationBreakdown, LocationCountry } from "@/lib/queries/types";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

/** Known countries shown before "Show all"; the Unknown row is always shown. */
const INITIAL_COUNTRIES = 10;

/** What the Region cell of a country row says: its one region, or how many. */
function regionSummary(country: LocationCountry): string {
  if (country.countryCode === null) return "—";
  if (country.regions.length === 1) return country.regions[0].region ?? "Unknown";
  return `${country.regions.length} regions`;
}

const num = (value: number) => value.toLocaleString("en-US");

export function LocationTable({ data }: { data: LocationBreakdown }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  if (data.totalToolCalls === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No data available
      </div>
    );
  }

  const toggle = (code: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  // The Unknown row sorts last; it stays visible however many countries are cut.
  const known = data.countries.filter((c) => c.countryCode !== null);
  const unknown = data.countries.filter((c) => c.countryCode === null);
  const countries = [...(showAll ? known : known.slice(0, INITIAL_COUNTRIES)), ...unknown];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Location known for{" "}
        <span className="font-medium text-foreground">
          {formatPercent(data.locatedToolCalls / data.totalToolCalls)}
        </span>{" "}
        of tool calls — ChatGPT only. ChatGPT sends it only to apps that capture tool arguments;
        every other call is listed as Unknown.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs uppercase tracking-wider">Country</TableHead>
            <TableHead className="text-xs uppercase tracking-wider">Region</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wider">
              Tool calls
            </TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wider">Users</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {countries.map((country) => {
            const key = country.countryCode ?? "__unknown";
            // A country with one region bucket shows it inline; nothing to expand.
            const expandable = country.regions.length > 1;
            const isOpen = expandable && expanded.has(key);
            return (
              <Fragment key={key}>
                <TableRow
                  className={cn(expandable && "cursor-pointer")}
                  onClick={expandable ? () => toggle(key) : undefined}
                  aria-expanded={expandable ? isOpen : undefined}
                >
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      <ChevronRight
                        className={cn(
                          "h-4 w-4 shrink-0 transition-transform",
                          !expandable && "invisible",
                          isOpen && "rotate-90",
                        )}
                      />
                      <span className={cn(country.countryCode === null && "text-muted-foreground")}>
                        {country.countryCode === null
                          ? "Unknown"
                          : formatCountry(country.countryCode)}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{regionSummary(country)}</TableCell>
                  <TableCell className="text-right">{num(country.toolCalls)}</TableCell>
                  <TableCell className="text-right">{num(country.users)}</TableCell>
                </TableRow>
                {isOpen &&
                  country.regions.map((region) => (
                    <TableRow
                      key={`${key}:${region.region ?? "__unknown"}`}
                      className="bg-muted/30"
                    >
                      <TableCell />
                      <TableCell className={cn(region.region === null && "text-muted-foreground")}>
                        {region.region ?? "Unknown"}
                      </TableCell>
                      <TableCell className="text-right">{num(region.toolCalls)}</TableCell>
                      <TableCell className="text-right">{num(region.users)}</TableCell>
                    </TableRow>
                  ))}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      {known.length > INITIAL_COUNTRIES && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show fewer" : `Show all ${known.length} countries`}
        </button>
      )}
    </div>
  );
}
