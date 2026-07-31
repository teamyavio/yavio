-- 0011_project_isolation.sql
-- events/sessions_mv/users_mv carried only a workspace_id row policy, while
-- tool_registry alone was project-scoped. Every dashboard query filters by
-- project_id in its WHERE clause, so this was invisible — until run_query let
-- a model write its own SQL. Asked "how many calls did project X get?", a
-- model that omits the predicate gets the WORKSPACE total and reports it as
-- the project's, with no error and no signal. Measured before this migration:
-- a project holding 719 of a workspace's 1586 events returned all 1586.
--
-- RESTRICTIVE so it is AND-ed with workspace_isolation; a second permissive
-- policy would be OR-ed and would WIDEN access instead of narrowing it.

CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.events
  AS RESTRICTIVE
  USING project_id = getSetting('SQL_project_id')
  TO yavio_dashboard;

CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.sessions_mv
  AS RESTRICTIVE
  USING project_id = getSetting('SQL_project_id')
  TO yavio_dashboard;

CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.users_mv
  AS RESTRICTIVE
  USING project_id = getSetting('SQL_project_id')
  TO yavio_dashboard;
