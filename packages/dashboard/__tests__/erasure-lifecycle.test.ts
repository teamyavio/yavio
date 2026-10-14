import { afterEach, describe, expect, it, vi } from "vitest";
import { ErasureWorker } from "../lib/erasure/worker";

// The worker's scheduling (#91 part 2): the timer, and that a kick while a run
// is in progress runs once more afterwards instead of overlapping or being
// lost. What a run does is tested against real databases in
// erasure.integration.test.ts.

/** A reserved connection whose try-lock says another instance holds it. */
function unlocked() {
  return Object.assign(async () => [{ locked: false }], { release: vi.fn() });
}

function fakeDb() {
  const runs: Array<() => void> = [];
  // Each run reserves a connection for its session lock (withSessionLock);
  // the reservation stays pending until the test releases it, and then the
  // lock is taken: nothing to do.
  const reserve = vi.fn(
    () =>
      new Promise<ReturnType<typeof unlocked>>((resolve) => {
        runs.push(() => resolve(unlocked()));
      }),
  );
  return { db: { $client: { reserve } }, reserve, runs };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ErasureWorker scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs again after a kick that arrived during a run — once, not per kick", async () => {
    const { db, reserve, runs } = fakeDb();
    const w = new ErasureWorker({ db: db as never, clickhouse: () => ({}) as never });

    w.kick();
    await flush();
    expect(reserve).toHaveBeenCalledTimes(1);

    w.kick(); // a deletion committed while the first run is still working
    w.kick();
    expect(reserve).toHaveBeenCalledTimes(1); // no overlap

    runs[0]();
    await flush();
    await flush();
    await flush();
    expect(reserve).toHaveBeenCalledTimes(2); // the queued kick

    runs[1]();
    await flush();
    await flush();
    await flush();
    expect(reserve).toHaveBeenCalledTimes(2); // and nothing more
  });

  it("processPending returns the run in progress instead of starting another", async () => {
    const { db, reserve, runs } = fakeDb();
    const w = new ErasureWorker({ db: db as never, clickhouse: () => ({}) as never });
    const a = w.processPending();
    const b = w.processPending();
    await flush();
    expect(reserve).toHaveBeenCalledTimes(1);
    runs[0]();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
  });

  it("logs a failed run instead of throwing out of kick()", async () => {
    const error = vi.fn();
    const db = { $client: { reserve: vi.fn(async () => Promise.reject(new Error("pg down"))) } };
    const w = new ErasureWorker({
      db: db as never,
      clickhouse: () => ({}) as never,
      logger: { info: vi.fn(), error },
    });
    w.kick();
    await flush();
    await flush();
    expect(error).toHaveBeenCalledWith("[erasure] worker run failed", expect.any(Error));
  });

  it("start() runs it on the interval until stop()", async () => {
    vi.useFakeTimers();
    const reserve = vi.fn(async () => unlocked());
    const w = new ErasureWorker({
      db: { $client: { reserve } } as never,
      clickhouse: () => ({}) as never,
      intervalMs: 1_000,
    });
    w.start();
    w.start(); // idempotent: one timer
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reserve).toHaveBeenCalledTimes(3);
    w.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reserve).toHaveBeenCalledTimes(3);
  });
});

describe("lib/erasure (process-wide worker)", () => {
  it("creates one worker, kicks it after deletions, and starts it at boot", async () => {
    vi.resetModules();
    const instances: Array<{ start: ReturnType<typeof vi.fn>; kick: ReturnType<typeof vi.fn> }> =
      [];
    vi.doMock("@/lib/db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/clickhouse", () => ({ getMutatingClickHouseClient: () => ({}) }));
    vi.doMock("@/lib/erasure/worker", () => ({
      ErasureWorker: class {
        start = vi.fn();
        kick = vi.fn();
        constructor() {
          instances.push(this);
        }
      },
    }));
    const mod = await import("@/lib/erasure");

    expect(mod.getErasureWorker()).toBe(mod.getErasureWorker());
    mod.kickErasure();
    mod.startErasureWorker();
    expect(instances).toHaveLength(1);
    expect(instances[0].kick).toHaveBeenCalledTimes(2); // kickErasure + boot catch-up
    expect(instances[0].start).toHaveBeenCalledTimes(1);

    vi.doUnmock("@/lib/db");
    vi.doUnmock("@/lib/clickhouse");
    vi.doUnmock("@/lib/erasure/worker");
  });
});
