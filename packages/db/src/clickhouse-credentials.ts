import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { createClickHouseClient } from "./clickhouse-client.js";
import {
  MANAGED_USER_NAMES,
  UNUSABLE_PASSWORD_HASH,
  isPasswordless,
} from "./migrate-clickhouse-helpers.js";

type Client = ReturnType<typeof createClickHouseClient>;

/**
 * Read the authentication method of every managed user that exists.
 *
 * Returns only the users ClickHouse actually reported, so callers can tell
 * "this user is fine" apart from "I could not see this user" — which is the
 * distinction that decides whether a check has run at all.
 */
export async function readManagedUserAuth(client: Client): Promise<Map<string, string | string[]>> {
  const result = await client.query({
    query: "SELECT name, auth_type FROM system.users WHERE name IN {users:Array(String)}",
    query_params: { users: MANAGED_USER_NAMES },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ name: string; auth_type: string | string[] }>();
  return new Map(rows.map((r) => [r.name, r.auth_type]));
}

/**
 * Put any managed user that authenticates without a credential back into a
 * state where it authenticates nobody.
 *
 * CONDITIONAL ON PURPOSE. The obvious implementation is a migration that ALTERs
 * the user unconditionally, and that is worse than it looks: it would reset a
 * WORKING credential on every existing deployment and rely on applyUserPasswords
 * in the same process to put it back. Any environment drift between the migrator
 * and the dashboard would then leave the eraser unreachable — and the deletion
 * routes catch ClickHouse failures, log, and still return 200, so the operator
 * would see successful account deletions while the events were silently
 * retained. Repairing only the broken state cannot do that: a user already on a
 * real password is never touched.
 *
 * Returns the users it repaired, so the caller can report what happened rather
 * than assert it.
 */
export async function repairPasswordlessUsers(client: Client): Promise<string[]> {
  const authByUser = await readManagedUserAuth(client);
  const repaired: string[] = [];

  for (const [user, authType] of authByUser) {
    if (!isPasswordless(authType)) continue;
    await client.command({
      query: `ALTER USER ${user} IDENTIFIED WITH sha256_hash BY '${UNUSABLE_PASSWORD_HASH}'`,
    });
    repaired.push(user);
  }

  return repaired;
}

/**
 * Refuse to finish while any managed user can be authenticated into without a
 * credential.
 *
 * This is the check that would have caught the 0012 defect, which created
 * yavio_eraser with `IDENTIFIED WITH no_password` believing that could not
 * authenticate. In ClickHouse it authenticates with anything at all.
 *
 * Note why the rollout check written for 0012 could not have caught it: it
 * verified that yavio_eraser CAN authenticate, and a no_password account
 * authenticates with whatever credential you present — including the one you
 * believe you just set. A check that cannot fail proves nothing.
 *
 * Which is why this one refuses to pass vacuously. `SELECT ... FROM
 * system.users` is access-filtered rather than error-raising: a connection
 * without SHOW USERS sees only its own row and returns success, so "no rows"
 * would read as "nothing wrong" when it actually means "I saw nothing".
 *
 * Seeing even one managed user proves system.users is visible, and a user that
 * is genuinely absent is already fail-closed — no account, no access. So the
 * case worth refusing is the one where the caller expected users and this
 * inspected none.
 */
export async function assertNoPasswordlessUsers(
  client: Client,
  expectUsersToExist = false,
): Promise<void> {
  const authByUser = await readManagedUserAuth(client);

  if (expectUsersToExist && authByUser.size === 0) {
    throw new YavioError(
      ErrorCode.DB.CH_MIGRATION_FAILED,
      `Cannot verify ClickHouse credentials: migrations created ${MANAGED_USER_NAMES.join(", ")}, but none of them are visible in system.users. The migrating user most likely lacks SHOW USERS, which would make this check pass without inspecting anything.`,
      500,
      { users: MANAGED_USER_NAMES },
    );
  }

  const passwordless = [...authByUser]
    .filter(([, authType]) => isPasswordless(authType))
    .map(([user]) => user);

  if (passwordless.length > 0) {
    throw new YavioError(
      ErrorCode.DB.CH_MIGRATION_FAILED,
      `ClickHouse user(s) ${passwordless.join(", ")} authenticate with NO credential. In ClickHouse \`no_password\` means no credential is required — any password is accepted, including a wrong one. Set the matching CLICKHOUSE_*_PASSWORD (scripts/setup-env.sh generates them) and re-run this migration.`,
      500,
      { users: passwordless },
    );
  }
}
