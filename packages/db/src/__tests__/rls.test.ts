import { describe, expect, it, vi } from "vitest";
import type { Database } from "../client.js";
import { withRLS } from "../rls.js";

describe("withRLS", () => {
  it("opens a transaction and calls the callback", async () => {
    const mockExecute = vi.fn();
    const mockTx = { execute: mockExecute };
    const mockDb = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
    };

    const result = await withRLS(mockDb as unknown as Database, "user-123", async () => {
      return "test-result";
    });

    expect(mockDb.transaction).toHaveBeenCalledOnce();
    expect(result).toBe("test-result");
  });

  it("executes set_config with the provided userId", async () => {
    const mockExecute = vi.fn();
    const mockTx = { execute: mockExecute };
    const mockDb = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
    };

    await withRLS(mockDb as unknown as Database, "user-abc-123", async () => "ok");

    expect(mockExecute).toHaveBeenCalledOnce();
    // The argument is a drizzle SQL template — verify it was called
    const sqlArg = mockExecute.mock.calls[0][0];
    expect(sqlArg).toBeDefined();
  });

  it("passes the transaction as Database to the callback", async () => {
    const mockExecute = vi.fn();
    const mockTx = { execute: mockExecute, select: vi.fn() };
    const mockDb = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
    };

    let receivedTx: unknown;
    await withRLS(mockDb as unknown as Database, "user-123", async (tx) => {
      receivedTx = tx;
      return "ok";
    });

    expect(receivedTx).toBe(mockTx);
  });

  it("propagates errors from the callback", async () => {
    const mockDb = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute: vi.fn() })),
    };

    await expect(
      withRLS(mockDb as unknown as Database, "user-123", async () => {
        throw new Error("callback error");
      }),
    ).rejects.toThrow("callback error");
  });

  it("propagates the return value from the callback", async () => {
    const mockDb = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute: vi.fn() })),
    };

    const items = [{ id: 1 }, { id: 2 }];
    const result = await withRLS(mockDb as unknown as Database, "user-123", async () => items);

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
