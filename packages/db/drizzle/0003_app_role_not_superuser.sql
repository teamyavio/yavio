-- Custom migration: creates the `yavio_api` role the application connects as,
-- so the dashboard and ingest stop connecting to Postgres as a SUPERUSER.
--
-- Why a new role rather than de-privileging the existing one:
--   * yavio_service cannot be de-privileged. It is the container's bootstrap
--     user (POSTGRES_USER), and Postgres refuses outright:
--       "permission denied to alter role / The bootstrap user must have the
--        SUPERUSER attribute."
--   * yavio_app cannot be used. Migration 0002 REVOKEs it from oauth_clients,
--     oauth_codes and oauth_tokens, which the OAuth server must read and write
--     across users; and every policy from 0001 reads
--     current_setting('app.current_user_id'), which no application code sets,
--     so RLS-protected queries would error rather than return rows.
--
-- What yavio_api gives up compared with yavio_service: OS command execution via
-- COPY ... FROM/TO PROGRAM, access to every other database in the cluster,
-- pg_authid password hashes, role creation, and DDL. It keeps only the DML the
-- application actually performs. That shrinks the blast radius of a SQL
-- injection or an RCE in the app; it does not (and cannot) stop code that is
-- already trusted with the data from reading the data.
--
-- BYPASSRLS is granted deliberately. Authorization here lives in application
-- code (workspace-membership checks), and the 0001 policies are written for a
-- per-request session variable this architecture does not set. BYPASSRLS is a
-- narrow attribute — it confers none of the capabilities listed above.
--
-- NO PASSWORD IS SET HERE, on purpose. Migration 0001 created yavio_app with a
-- literal 'yavio_dev', which is published in a public repository and is how a
-- production superuser ended up on a well-known password. A role with no
-- password cannot authenticate under scram/md5, so this fails closed: the
-- operator sets POSTGRES_API_PASSWORD (scripts/setup-env.sh generates it) and
-- applies it with
--     ALTER ROLE yavio_api WITH PASSWORD '<value of POSTGRES_API_PASSWORD>';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yavio_api') THEN
    CREATE ROLE yavio_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- Idempotent: re-assert the attributes if the role predates this migration.
ALTER ROLE yavio_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO yavio_api;
--> statement-breakpoint

-- Every application table, including the three oauth tables that yavio_app is
-- revoked from — the OAuth server looks tokens up by hash across all users.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yavio_api;
--> statement-breakpoint

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yavio_api;
--> statement-breakpoint

-- Tables created by later migrations must be reachable without another grant.
ALTER DEFAULT PRIVILEGES FOR ROLE yavio_service IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yavio_api;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE yavio_service IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO yavio_api;
