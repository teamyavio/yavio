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
-- NO USABLE PASSWORD IS SET HERE, deliberately. Migration 0007 created its
-- siblings with the literal 'yavio_dev', which is published in this public
-- repository and is exactly the defect the 2026-08-05 work had to unwind. The
-- operator sets CLICKHOUSE_ERASER_PASSWORD (scripts/setup-env.sh generates it)
-- and migrate-clickhouse.ts applies it after migrations run, the same way
-- CLICKHOUSE_INGEST_PASSWORD and CLICKHOUSE_DASHBOARD_PASSWORD are applied.
--
-- AMENDED 2026-08-06. This statement originally read `IDENTIFIED WITH
-- no_password`, on the belief that an account with no password cannot
-- authenticate. That is Postgres behaviour. In ClickHouse `no_password` means no
-- credential is REQUIRED — the check succeeds for any password, including a
-- wrong one — so the original form failed open, not closed. sha256_hash takes a
-- digest whose preimage was never generated, which is the state the comment
-- above always intended. Deployments that already applied the original 0012 are
-- not re-run by the migrator and are repaired by 0013 instead.

CREATE USER IF NOT EXISTS yavio_eraser
  IDENTIFIED WITH sha256_hash BY '322464e430fa3579779f1c4b82b59b559c50126dccad25f347635cc480d07a33';

-- ALTER DELETE is the privilege ClickHouse checks for `ALTER TABLE ... DELETE`
-- (a lightweight mutation). Granting it alone means this identity can remove
-- rows and do nothing else — notably it cannot SELECT them first.
GRANT ALTER DELETE ON default.events TO yavio_eraser;
