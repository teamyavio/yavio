import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ERASURE_WORKER=off (lib/erasure/switch.ts): a non-production copy sharing a
// production ClickHouse must never execute a deletion, and must not need the
// production eraser credential to boot.

const saved = process.env.ERASURE_WORKER;

// The worker is created lazily from the database; with the switch off neither
// the start nor a kick may get that far.
vi.mock("@/lib/db", () => ({
  getDb: () => {
    throw new Error("getDb() must not be called with ERASURE_WORKER=off");
  },
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "ERASURE_WORKER");
  else process.env.ERASURE_WORKER = saved;
});

describe("erasureWorkerEnabled()", () => {
  it.each([undefined, "", "on", "ON", " on "])("is on for %j", async (value) => {
    if (value === undefined) Reflect.deleteProperty(process.env, "ERASURE_WORKER");
    else process.env.ERASURE_WORKER = value;
    const { erasureWorkerEnabled } = await import("@/lib/erasure/switch");
    expect(erasureWorkerEnabled()).toBe(true);
  });

  it.each(["off", "OFF", " off "])("is off for %j", async (value) => {
    process.env.ERASURE_WORKER = value;
    const { erasureWorkerEnabled } = await import("@/lib/erasure/switch");
    expect(erasureWorkerEnabled()).toBe(false);
  });

  it.each(["false", "0", "no", "maybe"])("rejects %j, naming the variable", async (value) => {
    process.env.ERASURE_WORKER = value;
    const { erasureWorkerEnabled } = await import("@/lib/erasure/switch");
    expect(() => erasureWorkerEnabled()).toThrow(
      /ERASURE_WORKER must be "on" \(default\) or "off"/,
    );
  });
});

describe("with ERASURE_WORKER=off", () => {
  beforeEach(() => {
    process.env.ERASURE_WORKER = "off";
  });

  it("startErasureWorker() and kickErasure() do nothing, not even open the database", async () => {
    const { kickErasure, startErasureWorker } = await import("@/lib/erasure");
    expect(() => startErasureWorker()).not.toThrow();
    expect(() => kickErasure()).not.toThrow();
  });

  it("the mutating ClickHouse client refuses to be created", async () => {
    process.env.CLICKHOUSE_ERASER_PASSWORD = "would-be-the-production-secret";
    try {
      const { getMutatingClickHouseClient } = await import("@/lib/clickhouse");
      expect(() => getMutatingClickHouseClient()).toThrow(/ERASURE_WORKER=off/);
    } finally {
      Reflect.deleteProperty(process.env, "CLICKHOUSE_ERASER_PASSWORD");
    }
  });
});
