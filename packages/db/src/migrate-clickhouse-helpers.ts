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
