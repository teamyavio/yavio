import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetConfigWarnings } from "../core/config.js";
import { SDK_VERSION as REACT_SDK_VERSION } from "../react/constants.js";
import { SDK_VERSION, createYavio, withYavio, yavio } from "../server/index.js";
import { _resetGlobalState } from "../server/proxy.js";
import { _sharedStateCount } from "../server/shared.js";

/**
 * A copy of `env` without `keys`. Not `process.env.X = undefined`, which
 * Node stores as the string "undefined" on the real env, and not `delete`
 * (Biome's `noDelete`): the describe blocks below replace `process.env`
 * with a copy and put the original back (#148 review round 2).
 */
function without(env: NodeJS.ProcessEnv, ...keys: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));
}

describe("withYavio", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = without(originalEnv, "YAVIO_API_KEY", "YAVIO_ENDPOINT");
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

  it("returns a value without registerTool() unwrapped, with one YAVIO-1107 error and no side effect", () => {
    _resetGlobalState();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sigterm = process.listenerCount("SIGTERM");
    const sigint = process.listenerCount("SIGINT");

    const notAServer = { connect: async () => {} };
    const result = withYavio(notAServer as unknown as McpServer, { apiKey: "yav_test" });
    expect(result).toBe(notAServer);
    const emptyInput = {};
    const empty = withYavio(emptyInput as unknown as McpServer, { apiKey: "yav_test" });
    expect(empty).toBe(emptyInput);

    // withYavio rejected before resolving anything: no transport, no listeners.
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(_sharedStateCount()).toBe(0);

    // wrap() on a client that already holds a transport: still unwrapped.
    const unsupportedInput = {};
    const client = createYavio({ apiKey: "yav_unsupported" });
    expect(client.wrap(unsupportedInput as unknown as McpServer)).toBe(unsupportedInput);
    expect(_sharedStateCount()).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigint + 1);

    // Once per process, however many unsupported values arrive.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("YAVIO-1107");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("registerTool");
    errorSpy.mockRestore();
    _resetGlobalState();
  });

  it("rejects a value with registerTool() but no connect() instead of throwing (YAVIO-1107)", () => {
    _resetGlobalState();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const half = { registerTool() {} };
    expect(() => withYavio(half as unknown as McpServer, { apiKey: "yav_test" })).not.toThrow();
    expect(withYavio(half as unknown as McpServer, { apiKey: "yav_test" })).toBe(half);
    const client = createYavio({ apiKey: "yav_half" });
    expect(client.wrap(half as unknown as McpServer)).toBe(half);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("YAVIO-1107");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("connect()");
    errorSpy.mockRestore();
    _resetGlobalState();
  });

  it("wrap() checks the shape before touching the shared state: no transport re-acquired after shutdown()", async () => {
    _resetGlobalState();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createYavio({ apiKey: "yav_after" });
    expect(_sharedStateCount()).toBe(1);
    await client.shutdown();
    expect(_sharedStateCount()).toBe(0);
    const notAServer = {};
    expect(client.wrap(notAServer as unknown as McpServer)).toBe(notAServer);
    expect(_sharedStateCount()).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    _resetGlobalState();
  });

  it("runs the shape check in no-op mode too (both entry points)", () => {
    _resetGlobalState();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notAServer = { connect: async () => {} };
    expect(createYavio().wrap(notAServer as unknown as McpServer)).toBe(notAServer);
    expect(withYavio(notAServer as unknown as McpServer)).toBe(notAServer);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("YAVIO-1107");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("createYavio().wrap()");
    // A real server in no-op mode is still returned unchanged, without the error.
    const server = new McpServer({ name: "test", version: "1.0" });
    expect(createYavio().wrap(server)).toBe(server);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    _resetGlobalState();
  });

  it("goes no-op for an invalid endpoint: no proxy, no transport, no listeners, no fetch, one YAVIO-1002 error", () => {
    _resetGlobalState();
    _resetConfigWarnings();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sigterm = process.listenerCount("SIGTERM");
    const sigint = process.listenerCount("SIGINT");
    for (const endpoint of [
      "localhost:3001/v1/events",
      "htps://ingest.example.com/v1/events",
      "ingest.example.com/v1/events",
    ]) {
      const server = new McpServer({ name: "test", version: "1.0" });
      expect(withYavio(server, { apiKey: "yav_test", endpoint })).toBe(server);
      const client = createYavio({ apiKey: "yav_test", endpoint });
      expect(client.wrap(server)).toBe(server);
    }
    expect(_sharedStateCount()).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("YAVIO-1002");
    // Not "no API key": the endpoint error is the story.
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes("YAVIO-1000"))).toEqual([]);
    fetchSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    _resetGlobalState();
  });

  it("warns about a missing API key once per process, not once per wrap", () => {
    _resetGlobalState();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      withYavio(new McpServer({ name: "test", version: "1.0" }));
      createYavio();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("YAVIO-1000");
    warnSpy.mockRestore();
    _resetGlobalState();
  });

  it("uses API key from environment variable", () => {
    process.env.YAVIO_API_KEY = "yav_env_key";
    const server = new McpServer({ name: "test", version: "1.0" });

    const result = withYavio(server);

    expect(result).not.toBe(server);
  });

  it("exports SDK_VERSION matching package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  // The version used to be two independent literals, one per entrypoint, and
  // only the server copy was checked — so a release could ship widget events
  // stamped with the previous version and nothing would say so. Both now
  // re-export core/version.ts. This guards the arrangement rather than the
  // value: it fails the moment someone reintroduces a literal in the React
  // bundle, which is what made the drift possible in the first place.
  it("serves the React bundle the same SDK_VERSION as the server entrypoint", () => {
    expect(REACT_SDK_VERSION).toBe(SDK_VERSION);
  });
});

describe("yavio singleton", () => {
  it("drops calls outside context with a single YAVIO-1105 warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // withYavio() resolved a config earlier in this file, so the SDK is active
    // and the drop is worth a warning — one, however many calls follow.
    yavio.track("orphan_event");
    yavio.identify("user-1");
    yavio.step("step-1");
    yavio.conversion("sale", { value: 10, currency: "USD" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("YAVIO-1105"));
    warnSpy.mockRestore();
  });

  it("has all expected methods", () => {
    expect(typeof yavio.identify).toBe("function");
    expect(typeof yavio.step).toBe("function");
    expect(typeof yavio.track).toBe("function");
    expect(typeof yavio.conversion).toBe("function");
  });
});
