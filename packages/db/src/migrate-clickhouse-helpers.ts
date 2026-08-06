import { ErrorCode, YavioError } from "@yavio/shared/errors";

/**
 * Extract the version prefix from a migration filename.
 * "0002_events_table.sql" → "0002"
 */
export function versionFromFilename(filename: string): string {
  const match = filename.match(/^(\d+)/);
  if (!match) {
    throw new YavioError(
      ErrorCode.DB.CH_MIGRATION_FAILED,
      `Invalid migration filename: ${filename}`,
      500,
      { filename },
    );
  }
  return match[1];
}

/**
 * Strip SQL comments from a string.
 * Removes full-line `-- …` comments and inline `-- …` trailing comments.
 */
export function stripComments(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .trim();
}

/**
 * Split a SQL file into individual statements.
 * Strips comments, splits on semicolons, filters empty results.
 */
export function splitStatements(sql: string): string[] {
  return stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The ClickHouse users whose credentials this migrator owns, paired with the
 * environment variable that supplies each one.
 *
 * Single source of truth: applyUserPasswords iterates it, the passwordless
 * repair and assertion derive their user list from it, and `warnWhenUnset`
 * keeps the per-user policy next to the user rather than in an `if` somewhere
 * downstream. Adding a user here is all it takes to bring it under the guard.
 */
export const MANAGED_USERS = [
  { user: "yavio_ingest", envVar: "CLICKHOUSE_INGEST_PASSWORD", warnWhenUnset: false },
  { user: "yavio_dashboard", envVar: "CLICKHOUSE_DASHBOARD_PASSWORD", warnWhenUnset: false },
  // Worth saying out loud: with no password the dashboard erases as the
  // CLICKHOUSE_URL superuser, which is the arrangement migration 0012 exists to
  // end. The other two are commonly left unset by deployments that share one
  // password, so warning on those would be noise.
  { user: "yavio_eraser", envVar: "CLICKHOUSE_ERASER_PASSWORD", warnWhenUnset: true },
] as const;

export const MANAGED_USER_NAMES = MANAGED_USERS.map((u) => u.user);

/**
 * A credential that authenticates nobody: a SHA-256 digest whose preimage was
 * never generated. Publishing it leaks nothing — it is a hash, not a password,
 * and a test asserts that presenting the digest itself is rejected.
 *
 * This exists because ClickHouse has no "disabled" authentication state.
 * `no_password` is the trap: it means no credential is REQUIRED, so it accepts
 * an empty password AND a wrong one.
 */
export const UNUSABLE_PASSWORD_HASH =
  "322464e430fa3579779f1c4b82b59b559c50126dccad25f347635cc480d07a33";

/**
 * `system.users.auth_type` is a single Enum on ClickHouse 24.3 and an Array
 * once multiple authentication methods per user landed. Accept both rather
 * than pinning to one server version.
 */
export function isPasswordless(authType: string | string[]): boolean {
  return (Array.isArray(authType) ? authType : [authType]).includes("no_password");
}
