/**
 * Date range presets of the analytics pages. Raw events are kept 13 months
 * (#85), so 12 months is the longest range that is always complete; a project
 * set to a shorter retention (#93) simply shows nothing before it.
 */
export const DATE_PRESETS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "3m", days: 90 },
  { label: "6m", days: 182 },
  { label: "12m", days: 365 },
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

// A window whose length is within an hour of a preset's counts as that
// preset: the picker highlights it as such, and the sidebar remembers it as
// "the last N days" rather than as fixed dates.
const PRESET_TOLERANCE_MS = 60 * 60 * 1000;

/** The preset a window's length corresponds to, or null for a custom range. */
export function presetFor(from: Date, to: Date): DatePreset | null {
  const length = to.getTime() - from.getTime();
  return DATE_PRESETS.find((p) => Math.abs(length - p.days * DAY_MS) < PRESET_TOLERANCE_MS) ?? null;
}

/** The preset's window ending now: the last N days. */
export function presetWindow(preset: DatePreset, now = new Date()): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - preset.days * DAY_MS), to: now };
}
