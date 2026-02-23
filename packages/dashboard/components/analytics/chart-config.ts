/**
 * Shared chart configuration for analytics views.
 * Monochrome palette per design guide 2.5.
 */

export const CHART_COLORS = [
  "var(--color-chart-1, #0a0a0a)",
  "var(--color-chart-2, #404040)",
  "var(--color-chart-3, #737373)",
  "var(--color-chart-4, #a3a3a3)",
  "var(--color-chart-5, #d4d4d4)",
  "var(--color-chart-6, #e5e5e5)",
] as const;

export const SEMANTIC_COLORS = {
  success: "var(--color-success, #22c55e)",
  error: "var(--color-error, #ef4444)",
  warning: "var(--color-warning, #f59e0b)",
  info: "var(--color-info, #3b82f6)",
} as const;

export const EVENT_TYPE_COLORS: Record<string, string> = {
  tool_call: "#0a0a0a",
  conversion: "#22c55e",
  identify: "#3b82f6",
  step: "#f59e0b",
  page_view: "#737373",
  widget_render: "#a3a3a3",
  widget_click: "#404040",
  session_start: "#d4d4d4",
  session_end: "#e5e5e5",
};

export const COMMON_CHART_PROPS = {
  strokeWidth: 1.5,
  fillOpacity: 0.07,
  animationDuration: 0,
  dot: false,
} as const;

export const COMMON_GRID_PROPS = {
  strokeDasharray: "3 3",
  vertical: false,
  stroke: "var(--color-border, #e5e5e5)",
} as const;

export const COMMON_AXIS_PROPS = {
  tick: { fontSize: 12, fill: "var(--color-muted-foreground, #737373)" },
  tickLine: false,
  axisLine: false,
} as const;
