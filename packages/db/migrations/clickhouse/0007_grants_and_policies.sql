-- 0007_grants_and_policies.sql
-- Creates application users, grants, and row policies for tenant isolation.
-- Run as the default user (access_management enabled in users.xml).
--
-- Passwords default to 'yavio_dev' for local development.
-- The migration runner should substitute production passwords from env vars.

-- ═══════════════════════════════════════════════════════════════════════════════
-- Users
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE USER IF NOT EXISTS yavio_ingest IDENTIFIED BY 'yavio_dev';
CREATE USER IF NOT EXISTS yavio_dashboard IDENTIFIED BY 'yavio_dev';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Grants
-- ═══════════════════════════════════════════════════════════════════════════════

-- yavio_ingest: INSERT on events and tool_registry.
-- SELECT on events is required because materialized views read from it during INSERT.
GRANT INSERT, SELECT ON default.events TO yavio_ingest;
GRANT INSERT ON default.tool_registry TO yavio_ingest;

-- yavio_dashboard: SELECT on all tables and views
GRANT SELECT ON default.* TO yavio_dashboard;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Row Policies (tenant isolation for yavio_dashboard)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Dashboard queries must set custom settings:
--   SET SQL_workspace_id = '<workspace-id>';
--   SET SQL_project_id   = '<project-id>';
--
-- Fail-closed: if settings are omitted, the query fails with "Unknown setting".

-- Events table (workspace-scoped)
CREATE ROW POLICY IF NOT EXISTS workspace_isolation ON default.events
  USING workspace_id = getSetting('SQL_workspace_id')
  TO yavio_dashboard;

-- Sessions materialized view (workspace-scoped)
CREATE ROW POLICY IF NOT EXISTS workspace_isolation ON default.sessions_mv
  USING workspace_id = getSetting('SQL_workspace_id')
  TO yavio_dashboard;

-- Users materialized view (workspace-scoped)
CREATE ROW POLICY IF NOT EXISTS workspace_isolation ON default.users_mv
  USING workspace_id = getSetting('SQL_workspace_id')
  TO yavio_dashboard;

-- Tool registry (project-scoped)
CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.tool_registry
  USING project_id = getSetting('SQL_project_id')
  TO yavio_dashboard;
