/**
 * Navigation state of the analytics pages (#43): which section a URL is on
 * and which filters it carries, so sidebar links, the project switcher and
 * "Back to Dashboard" can keep both instead of resetting to Overview with
 * the 7-day default.
 */

import { DATE_PRESETS, presetFor, presetWindow } from "@/lib/analytics/date-presets";

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
  /** "?from=…" or "", in the form the pages read (absolute from/to). */
  search: string;
}

export const lastViewKey = (workspaceSlug: string, projectSlug: string) =>
  `yavio.last-view.${workspaceSlug}/${projectSlug}`;

// A remembered custom window is forgotten once its end is this far in the
// past: re-applying it would show weeks-old (usually empty) data with no
// hint why.
const LAST_VIEW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * What to remember for a project: the section and, when the URL has them,
 * its filters. A window the picker shows as a preset is stored as that
 * preset ("range=7d") so it is re-applied as "the last 7 days", never as the
 * fixed dates it happened to span when it was stored; only a custom calendar
 * range keeps its absolute from/to.
 */
export function serializeLastView(view: LastView): string {
  const params = new URLSearchParams(view.search);
  const from = parseDate(params.get("from"));
  const to = parseDate(params.get("to"));
  const out = new URLSearchParams();
  if (from && to) {
    const preset = presetFor(from, to);
    if (preset) {
      out.set("range", preset.label);
    } else {
      out.set("from", from.toISOString());
      out.set("to", to.toISOString());
    }
  }
  const platform = params.get("platform");
  if (platform) out.set("platform", platform);
  const search = out.toString();
  return `${view.section}${search ? `?${search}` : ""}`;
}

/**
 * Reads a remembered view back as a link the pages understand: a preset is
 * expanded to a fresh window ending `now`, a custom window is kept while it
 * is recent and dropped once it is stale, and both halves are validated so a
 * hand-edited value cannot produce a link outside the analytics pages, carry
 * params the filters do not own or an unparsable date.
 */
export function parseLastView(
  remembered: string | null | undefined,
  now = new Date(),
): LastView | null {
  if (!remembered) return null;
  const [section, search = ""] = remembered.split("?", 2);
  if (!isSection(section)) return null;
  const stored = new URLSearchParams(search);
  const out = new URLSearchParams();

  const preset = DATE_PRESETS.find((p) => p.label === stored.get("range"));
  if (preset) {
    const window = presetWindow(preset, now);
    out.set("from", window.from.toISOString());
    out.set("to", window.to.toISOString());
  } else {
    const from = parseDate(stored.get("from"));
    const to = parseDate(stored.get("to"));
    const recent = to !== null && now.getTime() - to.getTime() <= LAST_VIEW_MAX_AGE_MS;
    if (from && to && from < to && recent) {
      out.set("from", from.toISOString());
      out.set("to", to.toISOString());
    }
  }

  const platform = stored.get("platform");
  if (platform) out.set("platform", platform);
  return { section, search: analyticsFilterSearch(out) };
}
