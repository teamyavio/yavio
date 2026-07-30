-- Row-level security for the OAuth tables.
--
-- 0001 fences every user/workspace-scoped table, but its ALTER DEFAULT
-- PRIVILEGES also grants yavio_app full DML on tables created later — so the
-- three OAuth tables arrived readable/writable by yavio_app with no policy,
-- the only unfenced tables in the schema and the ones holding token material.
-- Latent today because the dashboard connects as yavio_service (which
-- bypasses RLS), but deployment.md prescribes yavio_app.
--
-- Scoping mirrors 0001: a user sees their own grants; clients are shared
-- registration metadata, readable to all app users and written only by
-- yavio_service (which bypasses RLS anyway).

ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY oauth_tokens_self ON oauth_tokens
  USING (user_id = current_setting('app.current_user_id')::uuid);
--> statement-breakpoint

ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY oauth_codes_self ON oauth_codes
  USING (user_id = current_setting('app.current_user_id')::uuid);
--> statement-breakpoint

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY oauth_clients_read ON oauth_clients
  FOR SELECT USING (true);
