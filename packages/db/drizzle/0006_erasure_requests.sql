-- Erasure queue (#91 part 2): one row per deleted workspace or project,
-- written in the same transaction as the Postgres delete and worked off by
-- the dashboard's erasure worker until every ClickHouse table is done.
CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tables_done" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_erasure_requests_pending" ON "erasure_requests" USING btree ("requested_at") WHERE completed_at IS NULL;
--> statement-breakpoint

-- Written and read by the dashboard (yavio_api). The RLS-enforced yavio_app
-- role has no business with it; 0001's default privileges would hand it DML.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yavio_app') THEN
    REVOKE ALL ON "erasure_requests" FROM yavio_app;
  END IF;
END
$$;
