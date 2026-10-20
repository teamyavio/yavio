import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDK_VERSION as REACT_SDK_VERSION } from "../react/constants.js";
import { SDK_VERSION, createYavio, withYavio, yavio } from "../server/index.js";
import { _resetGlobalState } from "../server/proxy.js";
import { _sharedStateCount } from "../server/shared.js";

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

  it("returns a value without registerTool() unwrapped, with one YAVIO-1107 error and no side effect", () => {
    _resetGlobalState();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sigterm = process.listenerCount("SIGTERM");

    const notAServer = { connect: async () => {} };
    const result = withYavio(notAServer as unknown as McpServer, { apiKey: "yav_test" });
    expect(result).toBe(notAServer);
    const empty = withYavio({} as unknown as McpServer, { apiKey: "yav_test" });
    expect(empty).toBe(empty);
    expect(createYavio({ apiKey: "yav_unsupported" }).wrap({} as unknown as McpServer)).toEqual({});

    // Once per process, however many unsupported values arrive.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("YAVIO-1107");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("registerTool");
    // withYavio rejected before resolving anything: no transport, no listeners.
    expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1); // createYavio above made one
    expect(_sharedStateCount()).toBe(1);
    errorSpy.mockRestore();
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
