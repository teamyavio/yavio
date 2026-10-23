"use client";

import { MAX_BACKGROUND_RETRIES, fetchAnalytics, isRetryableError } from "@/lib/analytics/request";
import useSWR from "swr";

interface UseAnalyticsQueryOptions {
  /** Full API URL (without query string) */
  url: string;
  /** Query string from useAnalyticsFilters */
  queryString: string;
  /** Disable the query */
  enabled?: boolean;
}

interface UseAnalyticsQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isRefetching: boolean;
  error: Error | undefined;
  retry: () => void;
}

export function useAnalyticsQuery<T>({
  url,
  queryString,
  enabled = true,
}: UseAnalyticsQueryOptions): UseAnalyticsQueryResult<T> {
  const key = enabled ? `${url}?${queryString}` : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(key, fetchAnalytics<T>, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
    // SWR's default retries every error with exponential backoff and no cap,
    // and with revalidateOnFocus off it keeps retrying in hidden tabs too. A
    // query that timed out, was rejected or needs more memory than allowed
    // fails the same way each time, at the full cost to ClickHouse, so it is
    // not retried; a transient failure keeps SWR's backoff (5 s, doubling,
    // jittered) for at most MAX_BACKGROUND_RETRIES retries (#159).
    shouldRetryOnError: isRetryableError,
    errorRetryCount: MAX_BACKGROUND_RETRIES,
  });

  return {
    data,
    isLoading,
    // After an error there is no cached data, so SWR reports a refresh as
    // isLoading; the page keeps showing the error, and isRefetching is what
    // dims it and spins the header's refresh button meanwhile (#159).
    isRefetching: isValidating && (!isLoading || error !== undefined),
    error: error as Error | undefined,
    retry: () => mutate(),
  };
}
