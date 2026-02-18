import { z } from "zod";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** UUID v4 string. */
export const Uuid = z.string().uuid();

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
// Pagination
// ---------------------------------------------------------------------------

export const PaginationParams = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationParams = z.infer<typeof PaginationParams>;

// ---------------------------------------------------------------------------
// Time range (analytics queries)
// ---------------------------------------------------------------------------

export const TimeRange = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});
export type TimeRange = z.infer<typeof TimeRange>;

// ---------------------------------------------------------------------------
// ISO currency code
// ---------------------------------------------------------------------------

export const CurrencyCode = z.string().length(3).toUpperCase();
