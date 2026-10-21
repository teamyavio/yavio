/**
 * Navigation state of the analytics pages (#43): which section a URL is on
 * and which filters it carries, so sidebar links, the project switcher and
 * "Back to Dashboard" can keep both instead of resetting to Overview with
 * the 7-day default.
 */

/** The analytics sections, in sidebar order. The sidebar's nav items are typed against this. */
export const ANALYTICS_SECTIONS = [
  "overview",
  "tools",
  "invocations",
  "funnels",
  "users",
  "paths",
  "live",
  "errors",
] as const;

export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];

/** The query params useAnalyticsFilters owns. Page-local params (page, tab, ...) stay behind. */
const FILTER_KEYS = ["from", "to", "platform"] as const;

function isSection(value: string | undefined): value is AnalyticsSection {
  return value !== undefined && (ANALYTICS_SECTIONS as readonly string[]).includes(value);
}

/**
 * The analytics filters of a query string as "?from=…&to=…&platform=…",
 * or "" when it carries none.
 */
export function analyticsFilterSearch(params: { get(name: string): string | null }): string {
  const out = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  const search = out.toString();
  return search ? `?${search}` : "";
}

/**
 * The section of a pathname under the project base path:
 * "/ws/proj/tools/search" → "tools". Null outside the analytics pages
 * (settings, account) or when the base path is unknown.
 */
export function analyticsSection(pathname: string, basePath: string): AnalyticsSection | null {
  if (!basePath || !pathname.startsWith(`${basePath}/`)) return null;
  const segment = pathname.slice(basePath.length + 1).split("/")[0];
  return isSection(segment) ? segment : null;
}

export interface LastView {
  section: AnalyticsSection;
  /** "?from=…" or "". */
  search: string;
}

export const lastViewKey = (workspaceSlug: string, projectSlug: string) =>
  `yavio.last-view.${workspaceSlug}/${projectSlug}`;

/** What to remember for a project: the section and, when the URL has them, its filters. */
export function serializeLastView(view: LastView): string {
  return `${view.section}${view.search}`;
}

/**
 * Reads a remembered view back, validating both halves: a stale or
 * hand-edited value cannot produce a link outside the analytics pages or
 * carry params the filters do not own.
 */
export function parseLastView(remembered: string | null | undefined): LastView | null {
  if (!remembered) return null;
  const [section, search = ""] = remembered.split("?", 2);
  if (!isSection(section)) return null;
  return { section, search: analyticsFilterSearch(new URLSearchParams(search)) };
}
