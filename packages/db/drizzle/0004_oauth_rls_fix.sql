-- 0003 fenced the OAuth tables with user-scoped policies. That was wrong, and
-- verified so against the yavio_app role the deployment spec prescribes:
--
--   SELECT ... FROM oauth_tokens WHERE access_token_hash = $1
--     -> ERROR: unrecognized configuration parameter "app.current_user_id"
--   INSERT INTO oauth_clients ...
--     -> ERROR: new row violates row-level security policy
--
-- Every OAuth access path looks these tables up BY HASH before any user
-- context exists — that is the point of a bearer token — so a policy keyed on
-- app.current_user_id can never match, and the whole authorization server
-- would stop working the day anyone switched the dashboard to yavio_app.
--
-- These are server-managed credential tables, not user-facing rows. The
-- correct protection is that the RLS-enforced role cannot touch them at all:
-- RLS stays ENABLED with no permissive policy (deny-all for yavio_app), and
-- the grant is revoked outright. yavio_service owns the tables and bypasses
-- RLS, which is how the server reads them.

DROP POLICY IF EXISTS oauth_tokens_self ON oauth_tokens;
--> statement-breakpoint
DROP POLICY IF EXISTS oauth_codes_self ON oauth_codes;
--> statement-breakpoint
DROP POLICY IF EXISTS oauth_clients_read ON oauth_clients;
--> statement-breakpoint

REVOKE ALL ON oauth_tokens FROM yavio_app;
--> statement-breakpoint
REVOKE ALL ON oauth_codes FROM yavio_app;
--> statement-breakpoint
REVOKE ALL ON oauth_clients FROM yavio_app;
--> statement-breakpoint

-- Future tables created by yavio_service must not hand yavio_app blanket DML
-- either; 0001's ALTER DEFAULT PRIVILEGES is what let these three slip in.
ALTER DEFAULT PRIVILEGES FOR ROLE yavio_service IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM yavio_app;
