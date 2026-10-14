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
