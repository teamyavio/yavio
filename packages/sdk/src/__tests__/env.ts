/**
 * Environment helpers for the SDK tests. Neither assigns `undefined` to
 * `process.env.X` — Node stores the string "undefined" on the real env,
 * which the next test reads as a set, invalid value (#148 review round 2).
 */

/**
 * A copy of `env` without `keys`, for tests that replace `process.env`
 * with a copy and put the original back. Not `delete` on the real env
 * (Biome's `noDelete`).
 */
export function without(env: NodeJS.ProcessEnv, ...keys: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));
}

/** Put an environment variable back as it was: removed when it was unset. */
export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
