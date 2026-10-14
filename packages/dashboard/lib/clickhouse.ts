import { createClickHouseClient } from "@yavio/db/clickhouse";

type ClickHouseClient = ReturnType<typeof createClickHouseClient>;

/**
 * The least-privileged ClickHouse user the dashboard has: SELECT on the four
 * policy-covered tables and nothing else.
 */
const DASHBOARD_CH_USER = "yavio_dashboard";

/** Holds only ALTER DELETE on default.events — see CH migration 0012. */
const ERASER_CH_USER = "yavio_eraser";

let readOnlyClient: ClickHouseClient | null = null;
let mutatingClient: ClickHouseClient | null = null;

function narrowedUrl(
  baseUrl: string | undefined,
  user: string,
  password?: string,
): string | undefined {
  if (!baseUrl) return baseUrl;
  try {
    const parsed = new URL(baseUrl);
    parsed.username = user;
    // Prefer the caller-supplied password, then this user's own, then the
    // URL's — so deployments still sharing one secret keep working.
    const own = password ?? process.env.CLICKHOUSE_DASHBOARD_PASSWORD;
    if (own) parsed.password = own;
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
 * The eraser password, or an error naming the variable.
 *
 * Called by instrumentation.ts when the server starts, so a deployment without
 * it refuses to boot instead of failing on the first deletion. It used to fall
 * back to the CLICKHOUSE_URL user — the `default` superuser — which kept the
 * very credential migration 0012 set out to retire in the dashboard process,
 * and a failure there was swallowed by the deletion routes (#91).
 */
export function requireEraserPassword(): string {
  const password = process.env.CLICKHOUSE_ERASER_PASSWORD;
  if (!password) {
    throw new Error(
      "CLICKHOUSE_ERASER_PASSWORD is not set. The dashboard erases account, workspace and " +
        "project data as the yavio_eraser ClickHouse user and no longer falls back to the " +
        "superuser. Run ./scripts/setup-env.sh or add it to .env, then run migrations so " +
        "migrate-clickhouse applies it.",
    );
  }
  return password;
}

/**
 * ClickHouse client that can run mutations, used ONLY by the deletion paths
 * (account / workspace / project deletion) which issue
 * `ALTER TABLE events DELETE`.
 *
 * It connects as yavio_eraser, which holds exactly ALTER DELETE on
 * default.events (CH migration 0012): enough to erase, not enough to read what
 * it erases, and nothing at all elsewhere. There is no fallback to another
 * user; requireEraserPassword() throws when the password is missing, and
 * instrumentation.ts has already refused to start the server in that case.
 *
 * History worth keeping: these deletion routes reach this module through a
 * DYNAMIC import (`await import("@/lib/clickhouse")`), so a static search for
 * `from "@/lib/clickhouse"` does not find them. Narrowing the single shared
 * client to yavio_dashboard therefore looked safe and was not — every erasure
 * silently failed with ACCESS_DENIED while the route still returned 200.
 * Splitting the clients is what makes that mistake impossible to repeat
 * silently: the read path cannot mutate, and the mutating path is explicit.
 */
export function getMutatingClickHouseClient(): ClickHouseClient {
  if (!mutatingClient) {
    mutatingClient = createClickHouseClient(
      narrowedUrl(process.env.CLICKHOUSE_URL, ERASER_CH_USER, requireEraserPassword()),
    );
  }
  return mutatingClient;
}
