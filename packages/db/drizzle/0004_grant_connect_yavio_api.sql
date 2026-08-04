-- Custom migration: grant yavio_api CONNECT on the database.
--
-- 0003 granted schema and table privileges but not CONNECT, which is enough on
-- a default install because PUBLIC holds CONNECT on every database. It is NOT
-- enough on a hardened deployment: revoking CONNECT from PUBLIC (so a role
-- cannot reach a database merely by existing) makes an explicit grant per role
-- mandatory, and yavio_api then fails with
--   FATAL: permission denied for database "yavio"
--   DETAIL: User does not have CONNECT privilege.
--
-- The database name is not fixed across environments, so it is resolved at run
-- time; GRANT ... ON DATABASE requires a literal identifier rather than an
-- expression.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yavio_api') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO yavio_api', current_database());
  END IF;
END
$$;
