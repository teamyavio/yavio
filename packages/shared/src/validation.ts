import { z } from "zod";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * A UUID-shaped string: 8-4-4-4-12 hex digits, of any version and variant.
 * `z.guid()`, which is zod 3's `.uuid()`: zod 4's `z.uuid()` also requires the
 * RFC 9562 version and variant bits, and would reject ids such as
 * `11111111-1111-1111-1111-111111111111` that ingest has always accepted.
 */
export const Uuid = z.guid();

/** Workspace slug: lowercase alphanumeric + hyphens, 3-48 chars. */
export const WorkspaceSlug = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Invalid workspace slug");

/** Project slug: lowercase alphanumeric + hyphens, 2-48 chars. */
export const ProjectSlug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Invalid project slug");

// ---------------------------------------------------------------------------
// API key format
// ---------------------------------------------------------------------------

/**
 * API key prefix: `yav_` followed by 32 hex chars.
 * The full key is only shown once at creation; after that only the prefix is stored.
 */
export const ApiKeyFormat = z.string().regex(/^yav_[a-f0-9]{32,}$/, "Invalid API key format");

/** The stored key prefix (first 8 chars after `yav_`). */
export const ApiKeyPrefix = z.string().regex(/^yav_[a-f0-9]{8}$/, "Invalid API key prefix");

// ---------------------------------------------------------------------------
// Session ID
// ---------------------------------------------------------------------------

/** MCP session ID: `ses_` prefix + alphanumeric. */
export const SessionId = z.string().regex(/^ses_[a-zA-Z0-9]+$/, "Invalid session ID");

// ---------------------------------------------------------------------------
// Workspace roles
// ---------------------------------------------------------------------------

export const WorkspaceRole = z.enum(["owner", "admin", "member", "viewer"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

// ---------------------------------------------------------------------------
// ISO datetime
// ---------------------------------------------------------------------------

/**
 * An ISO 8601 datetime in UTC: a `Z` suffix and no offset, with seconds
 * optional and any fraction of them (`2026-01-01T10:00Z`,
 * `2026-01-01T10:00:00.123Z`).
 *
 * This is zod 3's `.datetime()`. zod 4's requires the seconds (RFC 3339), so
 * the second branch adds the minute form back: ingest must not start
 * rejecting event timestamps it accepted before the zod 4 upgrade.
 */
export const IsoDatetime = z.union([z.iso.datetime(), z.iso.datetime({ precision: -1 })], {
  error: "Invalid ISO datetime",
});

// ---------------------------------------------------------------------------
// Time range (analytics queries)
// ---------------------------------------------------------------------------

export const TimeRange = z.object({
  from: IsoDatetime,
  to: IsoDatetime,
});
export type TimeRange = z.infer<typeof TimeRange>;
