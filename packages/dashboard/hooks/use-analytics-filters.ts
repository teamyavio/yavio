"use client";

import type { Granularity } from "@/lib/analytics/validation";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 300;

export interface AnalyticsFiltersState {
  from: Date;
  to: Date;
  platform: string[];
  granularity: Granularity;
}

export function useAnalyticsFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const filters: AnalyticsFiltersState = useMemo(() => {
    const now = new Date();
    return {
      from: searchParams.get("from")
        ? new Date(searchParams.get("from") as string)
        : new Date(now.getTime() - SEVEN_DAYS_MS),
      to: searchParams.get("to") ? new Date(searchParams.get("to") as string) : now,
      platform: searchParams.get("platform")
        ? (searchParams.get("platform") as string).split(",").filter(Boolean)
        : [],
      granularity: (searchParams.get("granularity") as Granularity) ?? "day",
    };
  }, [searchParams]);

  const setFilter = useCallback(
    (updates: Partial<AnalyticsFiltersState>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);

      debounceRef.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams.toString());
        if (updates.from) params.set("from", updates.from.toISOString());
        if (updates.to) params.set("to", updates.to.toISOString());
        if (updates.platform !== undefined) {
          if (updates.platform.length > 0) {
            params.set("platform", updates.platform.join(","));
          } else {
            params.delete("platform");
          }
        }
        if (updates.granularity) params.set("granularity", updates.granularity);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }, DEBOUNCE_MS);
    },
    [searchParams, router, pathname],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("from", filters.from.toISOString());
    params.set("to", filters.to.toISOString());
    if (filters.platform.length > 0) params.set("platform", filters.platform.join(","));
    params.set("granularity", filters.granularity);
    return params.toString();
  }, [filters]);

  return { filters, setFilter, queryString };
}
