# Dashboard Design Guide

Visual and interaction design specification for the Yavio dashboard. Built with **Tailwind CSS** + **shadcn/ui** + **Recharts 3.x** (via shadcn/ui chart components) + **@nivo/sankey** (for Sankey diagrams). This guide ensures consistency across all 7 analytics views, auth pages, settings, and onboarding flows.

The design follows the yavio.ai brand: **black and white, very minimal**. Spacing and typography create hierarchy — not color. Semantic color is reserved for data meaning (success, error, trends).

---

## 1. Design Principles

| Principle | Description |
|-----------|-------------|
| **Data-first** | Every pixel serves the data. Chrome is minimal. Charts and KPIs dominate viewport space. |
| **Scannable** | Users glance at the dashboard, not study it. Key numbers are large, trends are obvious, problems stand out. |
| **Black and white** | The UI itself is monochrome. Color is reserved for semantic meaning in data: success/error status, chart series, trends. |
| **Spacing over decoration** | Hierarchy comes from whitespace and font weight. Subtle shadows (`shadow-sm`, `shadow-md`) are used for depth and elevation, not decoration. |
| **Fast** | Perceived performance matters. Skeleton loaders appear instantly. No layout shift on data load. |
| **Accessible** | WCAG 2.1 AA. Keyboard navigable. Screen reader friendly. Color is never the sole indicator. |

---

## 2. Color System

### 2.1 Brand

The brand is black and white. There is no "brand color" — the product identity comes from typography, spacing, and the Yavio logomark.

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| `foreground` | `#0A0A0A` (neutral-950) | `#FAFAFA` (neutral-50) | Primary text, icons, active nav |
| `background` | `#FFFFFF` (white) | `#0A0A0A` (neutral-950) | Page background |
| `accent` | `#0A0A0A` (neutral-950) | `#FAFAFA` (neutral-50) | Primary buttons, active states |
| `accent-foreground` | `#FFFFFF` (white) | `#0A0A0A` (neutral-950) | Text on accent backgrounds |

### 2.2 Semantic

Used only for data meaning — never for decoration.

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| `success` | `#16A34A` (green-600) | `#4ADE80` (green-400) | Successful tool calls, conversions, healthy status |
| `error` | `#DC2626` (red-600) | `#F87171` (red-400) | Errors, failed calls, critical alerts |
| `warning` | `#D97706` (amber-600) | `#FBBF24` (amber-400) | Degraded status, approaching limits |
| `info` | `#2563EB` (blue-600) | `#60A5FA` (blue-400) | Informational badges, tips |

### 2.3 Surfaces

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| `bg-page` | `#FFFFFF` (white) | `#0A0A0A` (neutral-950) | Page background |
| `bg-card` | `#FFFFFF` (white) | `#171717` (neutral-900) | Cards, panels, popovers |
| `bg-sidebar` | `#FAFAFA` (neutral-50) | `#0F0F0F` (neutral-925) | Sidebar navigation |
| `bg-muted` | `#F5F5F5` (neutral-100) | `#262626` (neutral-800) | Table header rows, code blocks, input backgrounds |
| `border-default` | `#E5E5E5` (neutral-200) | `#404040` (neutral-700) | Card borders, dividers |
| `border-subtle` | `#F5F5F5` (neutral-100) | `#262626` (neutral-800) | Inner dividers, table row separators |

### 2.4 Text

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| `text-primary` | `#0A0A0A` (neutral-950) | `#FAFAFA` (neutral-50) | Headings, KPI values, primary labels |
| `text-secondary` | `#737373` (neutral-500) | `#A3A3A3` (neutral-400) | Descriptions, secondary labels, timestamps |
| `text-muted` | `#A3A3A3` (neutral-400) | `#737373` (neutral-500) | Placeholders, disabled text |

### 2.5 Chart Palette

Ordered sequence for multi-series charts. Deliberately muted to keep the overall feel restrained.

| Index | Light Mode | Dark Mode | Typical Usage |
|-------|-----------|-----------|---------------|
| 0 | `#0A0A0A` (neutral-950) | `#FAFAFA` (neutral-50) | Primary metric / first series |
| 1 | `#737373` (neutral-500) | `#A3A3A3` (neutral-400) | Second series |
| 2 | `#2563EB` (blue-600) | `#60A5FA` (blue-400) | Third series |
| 3 | `#16A34A` (green-600) | `#4ADE80` (green-400) | Fourth series / success-associated |
| 4 | `#D97706` (amber-600) | `#FBBF24` (amber-400) | Fifth series / warning-associated |
| 5 | `#DC2626` (red-600) | `#F87171` (red-400) | Sixth series / error-associated |

For single-metric charts (e.g., invocations over time), use chart color 0 (black). For success/error splits, use `success`/`error` semantic tokens directly.

### 2.6 Theme

Light mode is the default. Users can toggle via a theme switcher in the user settings dropdown. Preference is persisted in `localStorage` and respected via the `class` strategy in Tailwind (`dark:` prefix). System preference (`prefers-color-scheme`) is used as the fallback when no explicit choice is stored.

---

## 3. Typography

Uses the system font stack via Tailwind's `font-sans`. Monospace (`font-mono`) for code snippets, API keys, event names, and tool names.

| Element | Size | Weight | Font | Example |
|---------|------|--------|------|---------|
| Page title | `text-2xl` (24px) | `font-semibold` (600) | sans | "Overview", "Tool Explorer" |
| Section heading | `text-lg` (18px) | `font-medium` (500) | sans | "Invocations Over Time" |
| Card title | `text-sm` (14px) | `font-medium` (500) | sans | "Total Invocations" |
| KPI value | `text-3xl` (30px) | `font-semibold` (600) | sans | "1,247,892" |
| KPI label | `text-sm` (14px) | `font-normal` (400) | sans | "Total invocations" |
| Body text | `text-sm` (14px) | `font-normal` (400) | sans | Descriptions, table cells |
| Small text | `text-xs` (12px) | `font-normal` (400) | sans | Timestamps, badge labels |
| Code / monospace | `text-sm` (14px) | `font-normal` (400) | mono | `yav_abc1...`, `search_rooms` |

---

## 4. Layout

### 4.1 Page Shell

```
+-----------------------------------------------------------+
| Sidebar (w-56, fixed)  |  Main Content Area               |
|                        |                                   |
| [Workspace Switcher]   |  Page Header                     |
| [Project Selector]     |  ┌───────────────────────────┐   |
|                        |  │ Page Title    [Filters]    │   |
| Navigation             |  └───────────────────────────┘   |
|  ● Overview            |                                   |
|  ○ Tool Explorer       |  Content (scrollable)             |
|  ○ Funnel View         |  ┌───────────────────────────┐   |
|  ○ Users               |  │                           │   |
|  ○ Paths               |  │  KPI cards, charts,       │   |
|  ○ Live Feed           |  │  tables, etc.             │   |
|  ○ Errors              |  │                           │   |
|                        |  └───────────────────────────┘   |
| [Settings]             |                                   |
| [User Menu]            |                                   |
+-----------------------------------------------------------+
```

- **Sidebar:** Fixed `w-56` (224px) on desktop. `bg-sidebar` background. Separated from main content by a single `border-default` line. Collapsible to icon-only `w-14` (56px).
- **Main content:** Fills remaining width. Fluid. Horizontal padding `px-8`. Vertical padding `py-8`.
- **Page header:** Sticky top bar within main content. Contains page title (left) and filter controls (right). No background fill — just sits on the page background with bottom `border-subtle` separator.
- **Scroll:** Only the main content area scrolls. Sidebar and page header remain fixed.

### 4.2 Grid

Analytics pages use a responsive grid for KPI cards and chart panels. The dashboard targets desktop viewports only (1024px+). No mobile or tablet layouts are required.

| Breakpoint | Columns | KPI cards per row |
|-----------|---------|-------------------|
| `lg` (1024px–1279px) | 3 | 3 |
| `xl` (1280px+) | 4 | 4 |

Charts typically span 2 columns at `lg` and above. Full-width charts (e.g., time series, Sankey diagrams) span all columns.

### 4.3 Spacing Scale

Standard Tailwind spacing. Key usage:

| Spacing | Value | Usage |
|---------|-------|-------|
| `gap-4` | 16px | Between KPI cards in a row |
| `gap-6` | 24px | Between sections (e.g., KPI row and chart row) |
| `p-5` | 20px | Inner padding of cards |
| `p-6` | 24px | Inner padding of large chart panels |
| `space-y-1` | 4px | Between label and value in KPI cards |

---

## 5. Navigation

### 5.1 Sidebar Navigation

- **Workspace switcher** (top): Dropdown showing workspace name. Lists all workspaces the user belongs to. "+ Create workspace" at bottom.
- **Project selector** (below workspace): Dropdown showing project name. Lists all projects in the current workspace. "+ Create project" at bottom.
- **Nav items:** Icon + label. Active item uses `text-primary` with `font-medium` and a `bg-muted` background pill. Inactive items use `text-secondary`. Hover: `bg-muted`.
- **Bottom section:** Settings link, user avatar + name dropdown (theme toggle, account settings, sign out).

### 5.2 Page Header

- **Left:** Page title (`text-2xl font-semibold`).
- **Right:** Filter bar — date range picker (default: last 7 days), platform filter dropdown, additional view-specific filters. Filters apply instantly (optimistic UI).

### 5.3 Breadcrumbs

Only shown in nested views (e.g., user detail `Users > Alex Smith`, workspace settings subpages). Use shadcn `Breadcrumb` component. Separator: `/`.

---

## 6. Component Patterns

### 6.1 KPI Card

The primary metric display unit. Used across Overview, Tool Explorer, Errors, and Users.

```
┌─────────────────────────┐
│ Total Invocations       │  ← Card title (text-sm text-secondary)
│                         │
│ 1,247,892               │  ← KPI value (text-3xl font-semibold text-primary)
│ ▲ 12.3% vs prev period  │  ← Trend indicator (text-xs, green/red + arrow)
└─────────────────────────┘
```

- Border: `border border-default rounded-lg`
- Background: `bg-card`
- Padding: `p-5`
- Trend arrow: `▲` green for positive (good), `▼` red for negative (bad). Context-aware: for error rate, an increase is red (bad), not green.
- Hover: No hover state. KPI cards are read-only.
- Shadow: `shadow-sm` for subtle depth. Cards should not feel flat against the page background.

### 6.2 Chart Panel

Wraps a Recharts chart with a title and optional controls.

```
┌──────────────────────────────────────────────┐
│ Invocations Over Time           [7d][30d][3m]│  ← Title + time granularity toggle
│                                              │
│  ╭────────────────────────────╮              │
│  │                            │              │  ← Chart area (min-h-64)
│  │     📈 (line/bar/area)    │              │
│  │                            │              │
│  ╰────────────────────────────╯              │
└──────────────────────────────────────────────┘
```

- Same card styling as KPI card but with `p-6` padding.
- Chart area: minimum height `h-64` (256px). Responsive — fills available width.
- Tooltips: Show on hover. `bg-card` with `border-default` and `shadow-md` for elevation above chart content.
- Axes: `text-xs text-muted`. Y-axis labels right-aligned. X-axis labels below.
- Grid lines: `border-subtle`, horizontal only. Dashed (`strokeDasharray="4 4"`).

### 6.3 Data Table

Used in Tool Explorer (tool list), Users (user list), Live Feed (event list), and Errors (error list).

- Use shadcn `Table` component.
- Header row: `text-xs font-medium text-secondary`, uppercase. No background fill.
- Body rows: `text-sm`. Separated by `border-subtle`.
- Hover: `bg-muted` on row hover.
- Clickable rows: Cursor pointer. Clicking navigates to detail view.
- Sorting: Click column header to sort. Arrow indicator (`▲`/`▼`) on active sort column.
- Pagination: Bottom-right. Show current page, total items. "Previous" / "Next" buttons.
- Numeric columns right-aligned. Text columns left-aligned.

### 6.4 Badge

Small status labels used for event types, statuses, roles, and plans.

| Variant | Style | Usage |
|---------|-------|-------|
| `default` | `bg-muted text-primary` | Default, roles, event types |
| `success` | `bg-green-50 text-green-700` (light) | `success` status, active, connected |
| `error` | `bg-red-50 text-red-700` (light) | `error` status, failed, critical |
| `warning` | `bg-amber-50 text-amber-700` (light) | Degraded, approaching limit |
| `outline` | `border border-default text-secondary` | Neutral metadata, counts |

Style: `text-xs font-medium px-2 py-0.5 rounded-md`. No rounded-full pills — use subtle rounded rectangles to stay in the minimal aesthetic.

### 6.5 Event Type Indicator

Used in the Live Feed. A subtle left-border color stripe (3px wide) on each event row, plus a text label.

| Event Type | Stripe Color | Label |
|-----------|-------------|-------|
| `tool_call` | `text-primary` (black) | TOOL |
| `step` | `info` (blue) | STEP |
| `conversion` | `success` (green) | CONV |
| `error` (any with status=error) | `error` (red) | ERROR |
| `widget_*` | `text-secondary` (grey) | WIDGET |
| `connection` | `text-muted` (light grey) | CONN |
| `track` | `warning` (amber) | TRACK |

### 6.6 Empty State

Shown when a view has no data (new project, no events yet, no users identified).

```
┌──────────────────────────────────┐
│                                  │
│      No events recorded yet      │  ← Heading (text-lg font-medium)
│                                  │
│  Events will appear here once    │  ← Description (text-sm text-secondary)
│  your SDK starts sending data.   │
│                                  │
│      [View Setup Guide]          │  ← CTA button (primary)
│                                  │
└──────────────────────────────────┘
```

- No illustrations or icons — just text. Consistent with the minimal brand.
- Centered within the content area.
- Each view has a contextual empty state message. The Users view specifically explains `.identify()` is required.

### 6.7 Premium Feature Card

Shown when the intelligence service is not available. Replaces the premium content area.

```
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
  Behavioral Clustering
│                                  │
  Automatically group users by
│ behavior patterns.               │

│ Available with Cloud Pro →       │
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

- Dashed border (`border-dashed border-default`). No background fill.
- `text-secondary` for all text. The link uses `text-primary` with underline on hover.
- Non-intrusive. No icons, no color, no animation.

### 6.8 Forms

Used in auth pages (login, register), workspace/project creation, settings, and API key management.

- Use shadcn `Input`, `Select`, `Button`, `Label` components.
- Label above input. Required fields marked with `*` after label.
- Error messages below input in `text-xs text-error`.
- Input height: `h-10` (40px). Full width within form container.
- Primary button: `bg-accent text-accent-foreground` (black button, white text). Full width on auth pages. Inline on settings forms.
- Secondary button: `border border-default bg-transparent text-primary`. For cancel actions, secondary CTAs.
- Auth pages: Centered on a blank page (no sidebar), max-width `sm` (384px). Yavio logo above the form.

---

## 7. Data Visualization

### 7.1 Chart Types by View

| View | Chart Type | Library Component |
|------|-----------|-------------------|
| Overview — Invocations over time | Area chart | `AreaChart` |
| Overview — Platform breakdown | Donut chart | `PieChart` with inner radius |
| Overview — Top tools | Horizontal bar chart | `BarChart` (layout=vertical) |
| Overview — DAU/WAU/MAU | Line chart (multi-series) | `LineChart` |
| Tool Explorer — Latency distribution | Histogram | `BarChart` |
| Tool Explorer — Error rate over time | Area chart (stacked) | `AreaChart` |
| Funnel View — Step progression | Horizontal funnel bars | Custom (Tailwind CSS bars) |
| Users — Retention cohort | Heatmap matrix | Custom (Tailwind CSS grid + opacity scale) |
| Users — DAU/WAU/MAU | Line chart (multi-series) | `LineChart` |
| Users — New vs returning | Stacked area chart | `AreaChart` |
| Paths — Path visualization | Sankey diagram | `@nivo/sankey` |
| Live Feed — Event stream | No chart (event list) | — |
| Errors — Error rate over time | Area chart | `AreaChart` |
| Errors — Category breakdown | Donut chart | `PieChart` with inner radius |

### 7.2 Chart Styling Rules

- **No chart borders.** Charts float within their card with no box around the plot area.
- **Stroke:** `strokeWidth={1.5}`. Thin and precise, matching the minimal aesthetic.
- **Area fill opacity:** 5–8% of the stroke color. Barely visible — just enough to ground the line.
- **Gridlines:** Horizontal only. `stroke={border-subtle}`, `strokeDasharray="4 4"`.
- **Axis labels:** `text-xs text-muted`. Format large numbers with abbreviations (1.2M, 45.3K). Dates: "Mon 12", "Feb 14".
- **Tooltip:** Appears on hover. `bg-card` with `border-default` and `shadow-md`. Shows exact values, series name, and date. Number formatting matches KPI cards.
- **Legend:** Below chart, center-aligned. Small circle dot + label in `text-xs text-secondary`. Only shown for multi-series charts.
- **Animation:** None. Charts render instantly. No enter transitions, no easing, no morphing. Data updates are immediate.

### 7.3 Number Formatting

| Type | Format | Example |
|------|--------|---------|
| Counts | Comma-separated, abbreviated above 10K | `1,247,892` or `1.2M` |
| Percentages | One decimal place + `%` | `12.3%` |
| Latency | Milliseconds with unit | `142ms` |
| Revenue | Currency symbol + 2 decimals | `$1,234.56` |
| Dates (axis) | Short month + day | `Feb 14` |
| Dates (tooltip) | Full date | `February 14, 2026` |
| Timestamps | Relative when < 24h, absolute otherwise | `3m ago`, `Feb 14, 10:32 AM` |

### 7.4 Retention Cohort Heatmap

The retention matrix in the Users view uses a monochrome opacity scale:

| Retention % | Style |
|-------------|-------|
| 0% | `bg-muted` |
| 1–20% | `bg-neutral-950` at 10% opacity |
| 21–40% | `bg-neutral-950` at 25% opacity |
| 41–60% | `bg-neutral-950` at 40% opacity |
| 61–80% | `bg-neutral-950` at 60% opacity |
| 81–100% | `bg-neutral-950` at 80% opacity |

Cell text: white when background opacity >= 40%, `text-primary` otherwise.

---

## 8. Loading States

### 8.1 Skeleton Loaders

Every data-dependent component shows a skeleton placeholder while loading. Skeletons match the exact dimensions of the loaded content to prevent layout shift.

| Component | Skeleton |
|-----------|----------|
| KPI card | Animated pulse rectangle for value (`w-24 h-8`) + smaller rectangle for trend (`w-16 h-4`) |
| Chart | Animated pulse rectangle filling the chart area |
| Table | 5 rows of pulse rectangles matching column widths |
| Badge | Rounded rectangle pulse (`w-12 h-5`) |

Animation: `animate-pulse` (Tailwind built-in). Uses `bg-muted` color.

### 8.2 Page-Level Loading

On initial page load (SSR), the server component renders the page shell immediately. Data-dependent sections show skeletons. No full-page spinner.

### 8.3 Filter Changes

When filters change (date range, platform), charts show a subtle `opacity-50` while refetching. Skeleton loaders are not shown for filter updates — stale data remains visible at reduced opacity until fresh data arrives.

---

## 9. Error States

### 9.1 Query Error

When a ClickHouse query fails, the affected component shows an inline error.

```
┌──────────────────────────────────┐
│  Failed to load data             │  ← text-primary font-medium
│                                  │
│  Could not retrieve invocation   │  ← text-sm text-secondary
│  data. This may be temporary.    │
│                                  │
│  [Retry]                         │  ← text-sm underline, text-primary
└──────────────────────────────────┘
```

- Replaces the chart/table content. Card shell remains.
- No icons or color. Just text. Card retains its `shadow-sm`.
- Retry link attempts the query again.

### 9.2 Full Page Error

For critical failures (auth error, workspace not found): centered error page with message and link to dashboard home or login. Same minimal text style as empty states.

### 9.3 Toast Notifications

For transient actions (API key copied, member invited, settings saved): toast notification in bottom-right corner. Auto-dismiss after 4 seconds. Uses shadcn `Sonner`.

- Style: `bg-card border border-default shadow-lg`. No colored backgrounds. Text-only with a small icon prefix.
- Success: checkmark icon. Error: x icon. Info: no icon.

---

## 10. Interactive Patterns

### 10.1 Date Range Picker

- Dropdown with presets: "Last 24h", "Last 7 days" (default), "Last 30 days", "Last 3 months", "Custom range".
- Custom range: Calendar picker for start/end date.
- Selected range shown as label in the trigger button: "Feb 10 – Feb 17".

### 10.2 Filter Dropdowns

- Platform filter: Multi-select dropdown ("All platforms", "Server", "Widget").
- Tool filter (where applicable): Searchable dropdown listing all tools in the project.
- Filters persist across page navigation within a session (stored in URL query params).

### 10.3 Live Feed Interaction

- Events stream in from the top. No animation — new rows simply appear.
- Click to expand: Inline accordion showing full event detail (key-value pairs in a `bg-muted` block, monospace).
- Pause/resume toggle button in the page header.
- Color stripe on the left edge of each event row (3px), using the event type color from section 6.5.

### 10.4 Funnel Interaction

- Horizontal bars showing progression through funnel steps. Bars use `bg-neutral-950` (light) / `bg-neutral-50` (dark).
- Hover on a step to highlight the drop-off percentage between steps.
- Click on a drop-off gap to see example traces that dropped off at that step.

### 10.5 Path Visualization Interaction

- Sankey diagram: Monochrome links (grey) with black nodes. Hover on a node highlights connected paths.
- Click a node to filter: "Show all paths through this tool."
- Starting/ending point filters update the diagram in place.

---

## 11. Onboarding Flow

The onboarding wizard (create workspace → create project → generate key → wait for first event) uses a stepped layout:

- Centered card (max-width `lg`), no sidebar.
- Step indicator: numbered steps with a thin connecting line. Active step in `text-primary font-medium`. Completed steps show a checkmark. Future steps in `text-muted`.
- Each step is a single-action form. "Continue" button at bottom-right (primary style: black).
- "Waiting for first event" step: small pulsing dot + status text. Checks every 2 seconds. On success: checkmark replaces the dot, "Continue to dashboard" button appears.

---

## 12. Responsive Behavior

The dashboard targets desktop viewports only (1024px+). No mobile or tablet layouts are required.

| Breakpoint | Sidebar | KPI Grid | Charts | Tables |
|-----------|---------|----------|--------|--------|
| `1024–1279px` (desktop) | Full (`w-56`), collapsible to `w-14` | 3 columns | Span 2+ columns | Full table |
| `1280px+` (wide desktop) | Full (`w-56`), collapsible to `w-14` | 4 columns | Span 2+ columns | Full table |

- Auth pages: Always centered, single-column. No sidebar.
- Sidebar toggle state persisted in `localStorage`.

---

## 13. Accessibility

| Requirement | Implementation |
|-------------|----------------|
| Color contrast | All text meets WCAG 2.1 AA (4.5:1 for normal text, 3:1 for large text). Verified for both light and dark modes. |
| Color independence | Badges use text labels alongside any color. Chart series use different stroke patterns (solid, dashed) in addition to color. Trend arrows (`▲`/`▼`) supplement green/red. |
| Keyboard navigation | All interactive elements focusable via Tab. Focus ring: `ring-2 ring-neutral-950 ring-offset-2` (light) / `ring-neutral-50` (dark). Dropdowns, modals, and popovers support Escape to close. |
| Screen readers | Chart summaries via `aria-label` (e.g., "Line chart showing invocations over time, trending up 12% in the last 7 days"). Tables use proper `<th>` scope attributes. Live Feed updates announced via `aria-live="polite"`. |
| Reduced motion | Respect `prefers-reduced-motion`. Disable skeleton pulse animation when enabled. |
| Focus management | Modal open → focus first interactive element. Modal close → return focus to trigger. Route change → focus page title. |

---

## 14. Motion

Minimal by design. The dashboard avoids decorative animation.

| Element | Behavior | Duration |
|---------|----------|----------|
| Page transitions | None (instant route swap) | — |
| Sidebar collapse | Width transition | 150ms `ease-in-out` |
| Dropdown open | Opacity fade | 100ms `ease-out` |
| Toast enter | Slide in from right | 150ms `ease-out` |
| Toast exit | Fade out | 100ms `ease-in` |
| Skeleton pulse | Opacity cycle | 2000ms `ease-in-out` (infinite) |

No animation exceeds 150ms (except skeleton pulse). All animations disabled when `prefers-reduced-motion: reduce` is active.
