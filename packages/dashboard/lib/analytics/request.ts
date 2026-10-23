import { ErrorCode } from "@yavio/shared/error-codes";

/**
 * A non-2xx answer from an analytics API route. The routes answer
 * `{ error, code }` (`AnalyticsQueryError.toResponse()` and the auth,
 * rate-limit and validation guards), so the HTTP status and the YAVIO code
 * travel with the message the dashboard shows.
 */
export class AnalyticsRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AnalyticsRequestError";
  }
}

/** SWR fetcher for the analytics API routes: throws AnalyticsRequestError on a non-2xx answer. */
export async function fetchAnalytics<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    const { error, code } =
      typeof body === "object" && body !== null
        ? (body as { error?: unknown; code?: unknown })
        : {};
    throw new AnalyticsRequestError(
      typeof error === "string" ? error : `Request failed (HTTP ${res.status})`,
      res.status,
      typeof code === "string" ? code : undefined,
    );
  }
  return (await res.json()) as T;
}

/**
 * Query failures that repeat for the same request: the query ran out of time
 * (504), ClickHouse refused it (400), or it needs more memory than a query may
 * use (422). Each costs ClickHouse the full work up to the limit, and the
 * message already says what to change (narrow the date range).
 */
const DETERMINISTIC_CODES: ReadonlySet<string> = new Set([
  ErrorCode.DASHBOARD.ANALYTICS_QUERY_TIMEOUT, // YAVIO-3405
  ErrorCode.DASHBOARD.ANALYTICS_QUERY_REJECTED, // YAVIO-3407
  "YAVIO-3408", // ANALYTICS_QUERY_MEMORY_EXCEEDED (#157)
]);

/**
 * Whether the request failed because the session is gone (401, YAVIO-3000).
 * The proxy only sends page loads without a session cookie to /login, so an
 * expired session on an open page surfaces here instead.
 */
export function needsSignIn(error: unknown): boolean {
  return (
    error instanceof AnalyticsRequestError &&
    (error.status === 401 || error.code === ErrorCode.DASHBOARD.SESSION_EXPIRED)
  );
}

/** Background retries SWR makes for one failed request before it gives up (#159). */
export const MAX_BACKGROUND_RETRIES = 5;

/**
 * Whether repeating the same analytics request can succeed: the one retry
 * policy for SWR's background retries and the "Try again" button (#159).
 */
export function isRetryableError(error: unknown): boolean {
  // No answer at all (fetch() rejected: offline, connection reset): a later
  // attempt may well get one.
  if (!(error instanceof AnalyticsRequestError)) return true;
  if (error.code !== undefined && DETERMINISTIC_CODES.has(error.code)) return false;
  // A gateway timeout is the same query running out of time again.
  if (error.status === 504) return false;
  // 502 "try again later" (ClickHouse unreachable or overloaded), 500, 503.
  if (error.status >= 500) return true;
  // Any other 4xx is about the request itself (bad filters, signed out, no
  // access, query too big), except the two statuses that mean "later".
  return error.status === 408 || error.status === 429;
}
