/**
 * The single source of truth for the SDK version.
 *
 * This lived as two independent literals — one in the server entrypoint, one in
 * the React bundle — on the assumption that the React build could not reach the
 * server one. It could not, but it can reach `core/` (react/hook.ts already
 * imports core/pii.js), so the duplication was never structural. Two literals
 * meant every release was a three-file ritual in which a miss shipped widget
 * events stamped with the previous version.
 *
 * Keep this in step with packages/sdk/package.json — a test asserts they match.
 */
export const SDK_VERSION = "0.3.1";
