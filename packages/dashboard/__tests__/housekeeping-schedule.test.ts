import { afterEach, describe, expect, it, vi } from "vitest";

// The housekeeping job's scheduling (#92): runs at start and then on the
// interval, once per process, and a failing run is logged rather than thrown.
// What a run deletes is tested against Postgres in
// housekeeping.integration.test.ts.

vi.mock("../lib/oauth/store", () => ({ pruneExpired: vi.fn(async () => {}) }));

import { HousekeepingJob } from "../lib/housekeeping/job";

describe("HousekeepingJob scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at start, then on the interval, until stop()", async () => {
    vi.useFakeTimers();
    // null: another instance holds the lock, so a run does nothing.
    const db = { transaction: vi.fn(async () => null) };
    const job = new HousekeepingJob({ db: db as never, intervalMs: 1_000 });
    job.start();
    job.start(); // idempotent: one timer, one immediate run
    await vi.advanceTimersByTimeAsync(0);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(db.transaction).toHaveBeenCalledTimes(3);
    job.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });

  it("logs a failed run instead of throwing", async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const db = { transaction: vi.fn(async () => Promise.reject(new Error("pg down"))) };
    const job = new HousekeepingJob({
      db: db as never,
      logger: { info: vi.fn(), error },
      intervalMs: 1_000,
    });
    job.start();
    await vi.advanceTimersByTimeAsync(0);
    job.stop();
    expect(error).toHaveBeenCalledWith("[housekeeping] run failed", expect.any(Error));
  });
});

describe("lib/housekeeping (process-wide job)", () => {
  it("starts one job however often it is called", async () => {
    vi.resetModules();
    const instances: Array<{ start: ReturnType<typeof vi.fn> }> = [];
    vi.doMock("@/lib/db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/housekeeping/job", () => ({
      HousekeepingJob: class {
        start = vi.fn();
        constructor() {
          instances.push(this);
        }
      },
    }));
    const { startHousekeeping } = await import("@/lib/housekeeping");
    startHousekeeping();
    startHousekeeping();
    expect(instances).toHaveLength(1);
    expect(instances[0].start).toHaveBeenCalledTimes(2); // start() itself is idempotent
    vi.doUnmock("@/lib/db");
    vi.doUnmock("@/lib/housekeeping/job");
  });
});
