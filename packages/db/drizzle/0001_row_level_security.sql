-- Custom migration: creates yavio_app role and Row-Level Security policies.
-- Run as yavio_service (table owner, bypasses RLS by default).
-- RLS is enforced on yavio_app role only.
-- See: .specs/infrastructure/storage-layer.md §5.2.13

-- =============================================================================
-- Application role: RLS-enforced, used by dashboard API routes
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'yavio_app') THEN
    CREATE ROLE yavio_app LOGIN PASSWORD 'yavio_dev';
  END IF;
END
$$;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yavio_app;
--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO yavio_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE yavio_service IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yavio_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE yavio_service IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO yavio_app;
--> statement-breakpoint

-- =============================================================================
-- Helper function: returns workspace IDs the current user belongs to.
-- SECURITY DEFINER runs as yavio_service, bypassing RLS on workspace_members.
-- This prevents infinite recursion in workspace-scoped policies.
-- =============================================================================

CREATE FUNCTION user_workspace_ids()
RETURNS SETOF UUID AS $$
  SELECT workspace_id
  FROM workspace_members
  WHERE user_id = current_setting('app.current_user_id')::uuid;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;
--> statement-breakpoint

-- Restrict execution to yavio_app only
REVOKE ALL ON FUNCTION user_workspace_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_workspace_ids() TO yavio_app;
--> statement-breakpoint

-- =============================================================================
-- User-scoped tables: user can only access their own rows
-- =============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_self ON users
  USING (id = current_setting('app.current_user_id')::uuid);
--> statement-breakpoint

ALTER TABLE oauth_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY oauth_self ON oauth_accounts
  USING (user_id = current_setting('app.current_user_id')::uuid);
--> statement-breakpoint

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY session_self ON sessions
  USING (user_id = current_setting('app.current_user_id')::uuid);
--> statement-breakpoint

-- =============================================================================
-- Workspace-scoped tables: user can access rows in workspaces they belong to
-- =============================================================================

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_member ON workspaces
  USING (id IN (SELECT user_workspace_ids()));
--> statement-breakpoint

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY member_visibility ON workspace_members
  USING (workspace_id IN (SELECT user_workspace_ids()));
--> statement-breakpoint

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invitation_visibility ON invitations
  USING (workspace_id IN (SELECT user_workspace_ids()));
--> statement-breakpoint

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY project_visibility ON projects
  USING (workspace_id IN (SELECT user_workspace_ids()));
--> statement-breakpoint

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY key_visibility ON api_keys
  USING (workspace_id IN (SELECT user_workspace_ids()));
