-- Per-project retention (#93): 2-13 months, default 13 = the platform window.
-- The range is enforced here as well as in the dashboard. Never below 2: the
-- statistics job recomputes the previous month daily, and a shorter window
-- would delete raw events of a month it still recomputes.
ALTER TABLE "projects" ADD COLUMN "retention_months" integer DEFAULT 13 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_retention_months_range" CHECK ("projects"."retention_months" BETWEEN 2 AND 13);