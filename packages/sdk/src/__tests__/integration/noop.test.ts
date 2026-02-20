import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withYavio } from "../../server/index.js";

describe("No-op mode (no API key)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the original server unchanged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = new McpServer({ name: "test", version: "1.0" });

    const result = withYavio(server);

    expect(result).toBe(server);
    warnSpy.mockRestore();
  });

  it("tool registration still works on the original server", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = new McpServer({ name: "test", version: "1.0" });
    const result = withYavio(server);

    // Should not throw
    result.tool("my_tool", () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    warnSpy.mockRestore();
  });

  it("does not make any HTTP requests", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const server = new McpServer({ name: "test", version: "1.0" });
    withYavio(server);

    // Advance past any potential flush interval
    await vi.advanceTimersByTimeAsync(15_000);

    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
