import { getDb } from "@/lib/db";
import { HousekeepingJob } from "./job";

let job: HousekeepingJob | null = null;

/** Called once at server start (instrumentation.ts): hourly Postgres housekeeping (#92). */
export function startHousekeeping(): void {
  if (!job) job = new HousekeepingJob({ db: getDb(), logger: console });
  job.start();
}
