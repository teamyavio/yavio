import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../commands/init.js", () => ({ registerInit: vi.fn() }));
vi.mock("../commands/up.js", () => ({ registerUp: vi.fn() }));
vi.mock("../commands/down.js", () => ({ registerDown: vi.fn() }));
vi.mock("../commands/status.js", () => ({ registerStatus: vi.fn() }));
vi.mock("../commands/logs.js", () => ({ registerLogs: vi.fn() }));
vi.mock("../commands/update.js", () => ({ registerUpdate: vi.fn() }));
vi.mock("../commands/reset.js", () => ({ registerReset: vi.fn() }));
vi.mock("../commands/doctor.js", () => ({ registerDoctor: vi.fn() }));

describe("CLI entry point", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ["node", "yavio"];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("registers all commands and configures the program", async () => {
    await import("../index.js");

    const { registerInit } = await import("../commands/init.js");
    const { registerUp } = await import("../commands/up.js");
    const { registerDown } = await import("../commands/down.js");
    const { registerStatus } = await import("../commands/status.js");
    const { registerLogs } = await import("../commands/logs.js");
    const { registerUpdate } = await import("../commands/update.js");
    const { registerReset } = await import("../commands/reset.js");
    const { registerDoctor } = await import("../commands/doctor.js");

    expect(registerInit).toHaveBeenCalledOnce();
    expect(registerUp).toHaveBeenCalledOnce();
    expect(registerDown).toHaveBeenCalledOnce();
    expect(registerStatus).toHaveBeenCalledOnce();
    expect(registerLogs).toHaveBeenCalledOnce();
    expect(registerUpdate).toHaveBeenCalledOnce();
    expect(registerReset).toHaveBeenCalledOnce();
    expect(registerDoctor).toHaveBeenCalledOnce();
  });
});
