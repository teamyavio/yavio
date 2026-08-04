import { createClickHouseClient } from "@yavio/db/clickhouse";

type ClickHouseClient = ReturnType<typeof createClickHouseClient>;

/**
 * The least-privileged ClickHouse user the dashboard has: SELECT on the four
 * policy-covered tables and nothing else.
 */
const DASHBOARD_CH_USER = "yavio_dashboard";

let readOnlyClient: ClickHouseClient | null = null;
let mutatingClient: ClickHouseClient | null = null;

function narrowedUrl(baseUrl: string | undefined, user: string): string | undefined {
  if (!baseUrl) return baseUrl;
  try {
    const parsed = new URL(baseUrl);
    parsed.username = user;
    return parsed.toString();
  } catch {
    // Leave malformed values alone so createClickHouseClient reports the real
    // problem instead of an opaque URL parse error.
    return baseUrl;
  }
}

/**
 * Read-only ClickHouse client, for liveness checks and anything that only
 * reads.
 *
 * CLICKHOUSE_URL names the `default` superuser because migrations need DDL, so
 * the username is narrowed to yavio_dashboard, reusing the password from the
 * URL (all ClickHouse users on a deployment share one, which is what makes this
 * rewrite work).
 *
 * DO NOT use this for mutations. yavio_dashboard has SELECT only, so
 * `ALTER TABLE ... DELETE` fails with ACCESS_DENIED — see
 * getMutatingClickHouseClient below and the note on its call sites.
 */
export function getClickHouseClient(): ClickHouseClient {
  if (!readOnlyClient) {
    readOnlyClient = createClickHouseClient(
      narrowedUrl(process.env.CLICKHOUSE_URL, DASHBOARD_CH_USER),
    );
  }
  return readOnlyClient;
}

/**
 * ClickHouse client that can run mutations, used ONLY by the deletion paths
 * (account / workspace / project deletion) which issue
 * `ALTER TABLE events DELETE`.
 *
 * This deliberately keeps the user from CLICKHOUSE_URL rather than narrowing it.
 * Erasure needs the ALTER DELETE privilege, and yavio_dashboard does not have
 * it: migration 0010_narrow_dashboard_grant.sql grants that role SELECT on four
 * tables and nothing more.
 *
 * History worth keeping: these deletion routes reach this module through a
 * DYNAMIC import (`await import("@/lib/clickhouse")`), so a static search for
 * `from "@/lib/clickhouse"` does not find them. Narrowing the single shared
 * client to yavio_dashboard therefore looked safe and was not — every erasure
 * silently failed with ACCESS_DENIED while the route still returned 200.
 * Splitting the clients is what makes that mistake impossible to repeat
 * silently: the read path cannot mutate, and the mutating path is explicit.
 *
 * Follow-up worth doing: replace this with a dedicated least-privilege user
 * holding only `ALTER DELETE ON default.events`, so erasure does not need the
 * superuser either.
 */
export function getMutatingClickHouseClient(): ClickHouseClient {
  if (!mutatingClient) {
    mutatingClient = createClickHouseClient(process.env.CLICKHOUSE_URL);
  }
  return mutatingClient;
}
