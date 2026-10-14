-- Custom migration: only Yavio's roles may connect to the database (#92).
--
-- A fresh database grants CONNECT to PUBLIC, so any role in the cluster can
-- reach it merely by existing. Production revoked that by hand when its
-- credentials were hardened; this makes it the state of every install:
--   PUBLIC: no CONNECT; yavio_app and yavio_api: CONNECT.
-- The owner (yavio_service) keeps CONNECT as owner; superusers bypass it.
--
-- It does NOT cover a restore: pg_dump carries no database-level privileges,
-- and the restored migrations table already lists this migration, so it does
-- not run again. The disaster-recovery runbook (docs: Backups) re-applies the
-- same statements after a restore into a new cluster.
--
-- UPGRADE NOTE: a role of your own that connects to this database and is
-- neither the owner nor a superuser needs `GRANT CONNECT ON DATABASE <db> TO
-- <role>` after this migration.
--
-- The database name differs between environments, so it is resolved at run
-- time; GRANT ... ON DATABASE needs a literal identifier (see 0004).

DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yavio_app') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO yavio_app', current_database());
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yavio_api') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO yavio_api', current_database());
  END IF;
END
$$;
