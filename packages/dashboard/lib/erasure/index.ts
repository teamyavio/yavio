import { getMutatingClickHouseClient } from "@/lib/clickhouse";
import { getDb } from "@/lib/db";
import { erasureWorkerEnabled } from "./switch";
import { ErasureWorker } from "./worker";

let worker: ErasureWorker | null = null;

/**
 * The process-wide erasure worker (#91 part 2), created on first use: started
 * by instrumentation.ts when the server boots, and kicked by the delete
 * routes right after their transaction committed.
 */
export function getErasureWorker(): ErasureWorker {
  if (!worker) {
    worker = new ErasureWorker({
      db: getDb(),
      clickhouse: getMutatingClickHouseClient,
      logger: console,
    });
  }
  return worker;
}

/**
 * Process the queue now; called after a deletion queued a request. With
 * `ERASURE_WORKER=off` (see switch.ts) the request stays queued: nothing here
 * may touch ClickHouse.
 */
export function kickErasure(): void {
  if (!erasureWorkerEnabled()) return;
  getErasureWorker().kick();
}

/** Called once at server start: periodic retries, plus anything left over. */
export function startErasureWorker(): void {
  if (!erasureWorkerEnabled()) return;
  const w = getErasureWorker();
  w.start();
  w.kick();
}
