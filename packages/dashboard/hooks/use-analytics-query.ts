"use client";

import useSWR from "swr";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

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

  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(key, fetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
  });

  return {
    data,
    isLoading,
    isRefetching: isValidating && !isLoading,
    error: error as Error | undefined,
    retry: () => mutate(),
  };
}
