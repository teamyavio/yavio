-- Run state of ingest's anonymous-statistics job (#85): one row per stats
-- table, read and written under a Postgres advisory lock.
CREATE TABLE "stats_job_runs" (
	"job" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint

-- 0001's and 0003's default privileges hand every new table to yavio_app and
-- yavio_api. Ingest connects as yavio_api, which needs it. yavio_app is the
-- RLS-enforced role for tenant data and has no business with job state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yavio_app') THEN
    REVOKE ALL ON "stats_job_runs" FROM yavio_app;
  END IF;
END
$$;
