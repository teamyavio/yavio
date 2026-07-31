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

-- NOTE: deliberately NOT touching 0001's ALTER DEFAULT PRIVILEGES. Revoking
-- the default would silently deny yavio_app access to every FUTURE table too,
-- changing platform-wide behaviour far beyond these three and breaking the
-- next user-facing table someone adds under the existing RLS pattern. The
-- targeted revokes above are what this finding actually calls for.
