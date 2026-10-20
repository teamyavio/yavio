"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCountry, formatShare } from "@/lib/analytics/format";
import type { LocationBreakdown, LocationCountry } from "@/lib/queries/types";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

/** Countries shown before "Show all"; the Unknown row is always shown. */
const INITIAL_COUNTRIES = 10;

/** What the Region cell of a country row says: its one region, or how many. */
function regionSummary(country: LocationCountry): string {
  if (country.regions.length === 1) return country.regions[0].region ?? "Unknown";
  return `${country.regions.length} regions`;
}

const num = (value: number) => value.toLocaleString("en-US");

function Message({ children }: { children: string }) {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** `data` null: the location query failed; the rest of the Overview still loaded. */
export function LocationTable({ data }: { data: LocationBreakdown | null }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  if (data === null) return <Message>Locations are unavailable right now</Message>;
  if (data.totalToolCalls === 0) return <Message>No data available</Message>;

  const toggle = (code: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  const countries = showAll ? data.countries : data.countries.slice(0, INITIAL_COUNTRIES);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Location known for{" "}
        <span className="font-medium text-foreground">
          {formatShare(data.locatedToolCalls, data.totalToolCalls)}
        </span>{" "}
        of tool calls. It comes from the client platform (in practice ChatGPT) and only reaches apps
        that capture tool arguments; the rest is listed as Unknown.
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
            const key = country.countryCode;
            // A country with one region bucket shows it inline; nothing to expand.
            const expandable = country.regions.length > 1;
            const isOpen = expandable && expanded.has(key);
            const label = formatCountry(key);
            return (
              <Fragment key={key}>
                <TableRow>
                  <TableCell>
                    {expandable ? (
                      // A real button: focusable, Enter/Space open it, and the
                      // state is announced where it can be operated.
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-left hover:text-foreground"
                        aria-expanded={isOpen}
                        aria-label={`${label}: ${isOpen ? "hide" : "show"} regions`}
                        onClick={() => toggle(key)}
                      >
                        <ChevronRight
                          aria-hidden
                          className={cn(
                            "h-4 w-4 shrink-0 transition-transform",
                            isOpen && "rotate-90",
                          )}
                        />
                        {label}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <ChevronRight aria-hidden className="invisible h-4 w-4 shrink-0" />
                        {label}
                      </span>
                    )}
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
          {data.unknown && (
            <TableRow>
              <TableCell>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <ChevronRight aria-hidden className="invisible h-4 w-4 shrink-0" />
                  Unknown
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">—</TableCell>
              <TableCell className="text-right">{num(data.unknown.toolCalls)}</TableCell>
              <TableCell className="text-right">{num(data.unknown.users)}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data.countries.length > INITIAL_COUNTRIES && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show fewer" : `Show all ${data.countries.length} countries`}
        </button>
      )}
    </div>
  );
}
