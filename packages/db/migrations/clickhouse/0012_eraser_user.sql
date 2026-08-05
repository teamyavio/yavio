-- Dedicated user for the erasure path, so the dashboard stops needing the
-- ClickHouse `default` superuser.
--
-- Account, workspace and project deletion run `ALTER TABLE events DELETE`
-- (packages/dashboard/app/api/auth/account/route.ts and the two workspace
-- routes). Until now that went through getMutatingClickHouseClient(), which
-- keeps the user from CLICKHOUSE_URL — i.e. `default`, which is unrestricted.
-- The consequence is that the dashboard process holds a full-rights ClickHouse
-- credential in its environment for its whole lifetime, and the first deletion
-- opens a superuser connection. Any RCE, SSRF-to-localhost or env dump in the
-- Next.js process then yields DDL on the analytics store, up to DROP TABLE.
--
-- yavio_eraser gets exactly one capability: delete rows from default.events.
-- No SELECT, no INSERT, no DDL, nothing on any other table. It cannot read the
-- data it is allowed to erase.
--
-- NO PASSWORD IS SET HERE, deliberately. Migration 0007 created its siblings
-- with the literal 'yavio_dev', which is published in this public repository and
-- is exactly the defect the 2026-08-05 work had to unwind. A user with no
-- password cannot authenticate, so this fails closed: the operator sets
-- CLICKHOUSE_ERASER_PASSWORD (scripts/setup-env.sh generates it) and
-- migrate-clickhouse.ts applies it after migrations run, the same way
-- CLICKHOUSE_INGEST_PASSWORD and CLICKHOUSE_DASHBOARD_PASSWORD are applied.

CREATE USER IF NOT EXISTS yavio_eraser IDENTIFIED WITH no_password;

-- ALTER DELETE is the privilege ClickHouse checks for `ALTER TABLE ... DELETE`
-- (a lightweight mutation). Granting it alone means this identity can remove
-- rows and do nothing else — notably it cannot SELECT them first.
GRANT ALTER DELETE ON default.events TO yavio_eraser;
