import { createClickHouseClient } from "@yavio/db/clickhouse";

type ClickHouseClient = ReturnType<typeof createClickHouseClient>;

/**
 * The least-privileged ClickHouse user the dashboard has. Same role the
 * analytics client narrows to, so the dashboard never opens a `default`
 * (superuser) connection at all.
 */
const DASHBOARD_CH_USER = "yavio_dashboard";

let client: ClickHouseClient | null = null;

/**
 * ClickHouse client for liveness checks.
 *
 * CLICKHOUSE_URL names the `default` superuser because migrations need DDL.
 * This client only runs `SELECT 1`, so it has no business holding those rights;
 * the username is narrowed to yavio_dashboard exactly as analytics-client.ts
 * does, reusing the password from the URL (all ClickHouse users on a deployment
 * share one, which is what makes that rewrite pattern work).
 *
 * A malformed URL is passed through unchanged so the existing "CLICKHOUSE_URL
 * is not set" style failure surfaces, rather than a URL parse error.
 */
export function getClickHouseClient(): ClickHouseClient {
  if (!client) {
    const baseUrl = process.env.CLICKHOUSE_URL;
    let url = baseUrl;
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        parsed.username = DASHBOARD_CH_USER;
        url = parsed.toString();
      } catch {
        // leave as-is; createClickHouseClient reports the real problem
      }
    }
    client = createClickHouseClient(url);
  }
  return client;
}
