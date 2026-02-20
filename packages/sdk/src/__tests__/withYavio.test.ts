import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDK_VERSION, withYavio, yavio } from "../server/index.js";

describe("withYavio", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.YAVIO_API_KEY = undefined;
    process.env.YAVIO_ENDPOINT = undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns original server when no API key is found (no-op mode)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = new McpServer({ name: "test", version: "1.0" });

    const result = withYavio(server);

    // Should be the exact same object, not a proxy
    expect(result).toBe(server);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no-op mode"));
    warnSpy.mockRestore();
  });

  it("returns a proxied server when API key is provided", () => {
    const server = new McpServer({ name: "test", version: "1.0" });

    const result = withYavio(server, { apiKey: "yav_test" });

    // Should be a different object (proxy)
    expect(result).not.toBe(server);
    // But should still be usable as a McpServer
    expect(typeof result.tool).toBe("function");
    expect(typeof result.connect).toBe("function");
  });

  it("uses API key from environment variable", () => {
    process.env.YAVIO_API_KEY = "yav_env_key";
    const server = new McpServer({ name: "test", version: "1.0" });

    const result = withYavio(server);

    expect(result).not.toBe(server);
  });

  it("exports SDK_VERSION", () => {
    expect(SDK_VERSION).toBe("0.0.1");
  });
});

describe("yavio singleton", () => {
  it("is a no-op when called outside context", () => {
    // Should not throw
    yavio.track("orphan_event");
    yavio.identify("user-1");
    yavio.step("step-1");
    yavio.conversion("sale", { value: 10, currency: "USD" });
  });

  it("has all expected methods", () => {
    expect(typeof yavio.identify).toBe("function");
    expect(typeof yavio.step).toBe("function");
    expect(typeof yavio.track).toBe("function");
    expect(typeof yavio.conversion).toBe("function");
  });
});
