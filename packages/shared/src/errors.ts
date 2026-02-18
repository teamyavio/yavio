export { ErrorCode, type ErrorCodeValue } from "./error-codes.js";
import type { ErrorCodeValue } from "./error-codes.js";

/**
 * Base error class for all Yavio platform errors.
 *
 * Every error that surfaces to a user, appears in logs, or is captured by
 * Sentry uses a code from the error catalog (see .specs/07_error-catalog.md).
 *
 * @example
 * import { YavioError, ErrorCode } from "@yavio/shared/errors";
 * throw new YavioError(ErrorCode.DB.PG_MIGRATION_FAILED, "PostgreSQL migration failed", 500);
 * throw new YavioError(ErrorCode.DASHBOARD.WORKSPACE_SLUG_EXISTS, "Workspace slug already exists", 409, { slug });
 */
export class YavioError extends Error {
  constructor(
    public readonly code: ErrorCodeValue,
    message: string,
    public readonly status: number,
    public readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "YavioError";
  }
}

/**
 * Check whether an unknown caught value is a {@link YavioError}.
 */
export function isYavioError(err: unknown): err is YavioError {
  return err instanceof YavioError;
}
