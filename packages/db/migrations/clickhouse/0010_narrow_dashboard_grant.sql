-- 0010_narrow_dashboard_grant.sql
-- yavio_dashboard held SELECT on default.* — every table in the database,
-- present and future — while only four tables carry tenant row policies.
-- With free-form SQL now reaching ClickHouse through the MCP run_query tool,
-- the grant must be fail-closed: exactly the row-policy-covered tables, so a
-- future table added without a policy is unreadable instead of world-readable.

REVOKE SELECT ON default.* FROM yavio_dashboard;

GRANT SELECT ON default.events TO yavio_dashboard;

GRANT SELECT ON default.sessions_mv TO yavio_dashboard;

GRANT SELECT ON default.users_mv TO yavio_dashboard;

GRANT SELECT ON default.tool_registry TO yavio_dashboard;
