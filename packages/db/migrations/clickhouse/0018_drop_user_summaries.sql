-- #89 release 2: drop users_mv and sessions_mv.
--
-- Their columns were plain types under an AggregatingMergeTree, so every
-- background merge kept an arbitrary row per key: event and session counts
-- collapsed, first/last seen froze (#89). Since release 1 nothing reads them —
-- user metrics come from events with the stitched user key, sessions always
-- did — so they only kept growing, without a TTL, holding user ids.
--
-- DEPLOY ONLY AFTER release 1 (the dashboard that no longer queries them) is
-- running: migrate runs before the new dashboard starts, and an older
-- dashboard would query dropped tables.
--
-- ClickHouse keeps row policies and grants of a dropped table (they are
-- stored by name and would apply again to a new table of that name), so they
-- go explicitly: policies from 0007/0011, grants from 0010/0016.

DROP ROW POLICY IF EXISTS workspace_isolation ON default.users_mv;
DROP ROW POLICY IF EXISTS project_isolation ON default.users_mv;
DROP ROW POLICY IF EXISTS workspace_isolation ON default.sessions_mv;
DROP ROW POLICY IF EXISTS project_isolation ON default.sessions_mv;

REVOKE SELECT ON default.users_mv FROM yavio_dashboard;
REVOKE SELECT ON default.sessions_mv FROM yavio_dashboard;
REVOKE ALTER DELETE ON default.users_mv FROM yavio_eraser;
REVOKE ALTER DELETE ON default.sessions_mv FROM yavio_eraser;

-- A materialized view's inner table goes with it. SYNC: the space is freed now,
-- not after the Atomic database's delay.
DROP VIEW IF EXISTS default.users_mv SYNC;
DROP VIEW IF EXISTS default.sessions_mv SYNC;
