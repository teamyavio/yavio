import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetConfigWarnings,
  lastNoopReason,
  resolveConfig,
  shutdownTimeoutFromEnv,
} from "../core/config.js";
import type { CaptureConfig } from "../core/types.js";
import { without } from "./env.js";

describe("resolveConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = without(originalEnv, "YAVIO_API_KEY", "YAVIO_ENDPOINT");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when no API key is found", () => {
    expect(resolveConfig()).toBeNull();
  });

  it("resolves from code options (highest priority)", () => {
    process.env.YAVIO_API_KEY = "env_key";
    const config = resolveConfig({ apiKey: "code_key" });
    expect(config?.apiKey).toBe("code_key");
  });

  it("falls back to env var for API key", () => {
    process.env.YAVIO_API_KEY = "env_key";
    const config = resolveConfig();
    expect(config?.apiKey).toBe("env_key");
  });

  it("resolves endpoint from code options", () => {
    const config = resolveConfig({
      apiKey: "test",
      endpoint: "http://localhost:3001/v1/events",
    });
    expect(config?.endpoint).toBe("http://localhost:3001/v1/events");
  });

  it("falls back to env var for endpoint", () => {
    process.env.YAVIO_ENDPOINT = "http://custom:3001/v1/events";
    const config = resolveConfig({ apiKey: "test" });
    expect(config?.endpoint).toBe("http://custom:3001/v1/events");
  });

  it("uses default endpoint when none specified", () => {
    const config = resolveConfig({ apiKey: "test" });
    expect(config?.endpoint).toBe("https://ingest.yavio.ai/v1/events");
  });

  it("uses default capture config", () => {
    const config = resolveConfig({ apiKey: "test" });
    expect(config?.capture).toEqual({
      inputValues: true,
      outputValues: true,
      geo: true,
      conversationId: true,
      tokens: true,
      retries: true,
      rejectedInputValues: false,
    });
  });

  it("merges partial capture options", () => {
    const config = resolveConfig({
      apiKey: "test",
      capture: { inputValues: false },
    });
    expect(config?.capture).toEqual({
      inputValues: false,
      outputValues: true,
      geo: true,
      conversationId: true,
      tokens: true,
      retries: true,
      rejectedInputValues: false,
    });
  });

  describe("serverOnly", () => {
    it("defaults to false when nothing is configured", () => {
      const config = resolveConfig({ apiKey: "test" });
      expect(config?.serverOnly).toBe(false);
    });

    it("reads serverOnly from code options", () => {
      const config = resolveConfig({ apiKey: "test", serverOnly: true });
      expect(config?.serverOnly).toBe(true);
    });

    it("reads serverOnly from YAVIO_SERVER_ONLY=1", () => {
      process.env.YAVIO_SERVER_ONLY = "1";
      const config = resolveConfig({ apiKey: "test" });
      expect(config?.serverOnly).toBe(true);
    });

    it("reads serverOnly from YAVIO_SERVER_ONLY=true", () => {
      process.env.YAVIO_SERVER_ONLY = "true";
      const config = resolveConfig({ apiKey: "test" });
      expect(config?.serverOnly).toBe(true);
    });

    it("code option overrides env var", () => {
      process.env.YAVIO_SERVER_ONLY = "true";
      const config = resolveConfig({ apiKey: "test", serverOnly: false });
      expect(config?.serverOnly).toBe(false);
    });

    it("treats unknown env values as undefined (falls through to default)", () => {
      process.env.YAVIO_SERVER_ONLY = "maybe";
      const config = resolveConfig({ apiKey: "test" });
      expect(config?.serverOnly).toBe(false);
    });
  });

  describe(".yaviorc.json file discovery", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "yavio-config-test-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("reads API key from .yaviorc.json", () => {
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify({ apiKey: "file_key" }));
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;
      try {
        const config = resolveConfig();
        expect(config?.apiKey).toBe("file_key");
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("walks up directories to find config", () => {
      const childDir = join(tempDir, "nested", "deep");
      mkdirSync(childDir, { recursive: true });
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify({ apiKey: "parent_key" }));
      const originalCwd = process.cwd;
      process.cwd = () => childDir;
      try {
        const config = resolveConfig();
        expect(config?.apiKey).toBe("parent_key");
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("code options take priority over config file", () => {
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify({ apiKey: "file_key" }));
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;
      try {
        const config = resolveConfig({ apiKey: "code_key" });
        expect(config?.apiKey).toBe("code_key");
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("ignores malformed .yaviorc.json without crashing", () => {
      writeFileSync(join(tempDir, ".yaviorc.json"), "{ not valid json !!! }");
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;
      try {
        const config = resolveConfig();
        expect(config).toBeNull();
      } finally {
        process.cwd = originalCwd;
      }
    });
  });
});

describe("per-tool capture overrides (tools)", () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    process.env = without(originalEnv, "YAVIO_API_KEY");
    tempDir = mkdtempSync(join(tmpdir(), "yavio-tools-test-"));
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function withCwd<T>(dir: string, fn: () => T): T {
    const originalCwd = process.cwd;
    process.cwd = () => dir;
    try {
      return fn();
    } finally {
      process.cwd = originalCwd;
    }
  }

  it("defaults to no overrides", () => {
    expect(resolveConfig({ apiKey: "test" })?.tools).toEqual({});
  });

  it("passes code-option overrides through, leaving the global capture untouched", () => {
    const config = resolveConfig({
      apiKey: "test",
      tools: { book: { inputValues: false, outputValues: false, intent: false } },
    });
    expect(config?.tools).toEqual({
      book: { inputValues: false, outputValues: false, intent: false },
    });
    expect(config?.capture.inputValues).toBe(true);
  });

  it("reads tools from .yaviorc.json", () => {
    writeFileSync(
      join(tempDir, ".yaviorc.json"),
      JSON.stringify({ apiKey: "file_key", tools: { book: { inputValues: false } } }),
    );
    const config = withCwd(tempDir, () => resolveConfig());
    expect(config?.tools).toEqual({ book: { inputValues: false } });
  });

  it("merges file and code overrides per tool, field by field, code winning", () => {
    writeFileSync(
      join(tempDir, ".yaviorc.json"),
      JSON.stringify({
        apiKey: "file_key",
        tools: { book: { inputValues: false, outputValues: false }, other: { intent: false } },
      }),
    );
    const config = withCwd(tempDir, () =>
      resolveConfig({ tools: { book: { outputValues: true, intent: false } } }),
    );
    expect(config?.tools).toEqual({
      book: { inputValues: false, outputValues: true, intent: false },
      other: { intent: false },
    });
  });

  it("ignores unknown keys and non-object entries from the config file", () => {
    writeFileSync(
      join(tempDir, ".yaviorc.json"),
      JSON.stringify({
        apiKey: "file_key",
        tools: {
          book: { geo: false, intent: false },
          bogus: "not an object",
          empty: { unknownKey: true },
        },
      }),
    );
    const config = withCwd(tempDir, () => resolveConfig());
    expect(config?.tools).toEqual({ book: { intent: false } });
  });

  it('fails closed on a non-boolean override: "false" turns the tool\'s capture off', () => {
    // Dropping the string would leave the tool on the global default — capture
    // ON — for the one tool the integrator meant to protect.
    _resetConfigWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({
          apiKey: "file_key",
          tools: { book: { inputValues: "false", outputValues: 0, intent: "no" } },
        }),
      );
      const config = withCwd(tempDir, () => resolveConfig());
      expect(config?.tools).toEqual({
        book: { inputValues: false, outputValues: false, intent: false },
      });
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[0][0]).toContain("YAVIO-1006");
      expect(warn.mock.calls[0][0]).toContain("tools.book.inputValues");
    } finally {
      warn.mockRestore();
    }
  });

  it("treats __proto__ and constructor as tool names, never as the object's prototype", () => {
    // JSON.parse makes `__proto__` an own key; assigning it on a plain object
    // would have replaced the prototype and the override would be lost.
    const config = resolveConfig({
      apiKey: "test",
      tools: JSON.parse('{"__proto__": {"inputValues": false}, "constructor": {"intent": false}}'),
    });
    expect(Object.hasOwn(config?.tools ?? {}, "__proto__")).toBe(true);
    // biome-ignore lint/complexity/useLiteralKeys: `.__proto__` would read the prototype accessor on an ordinary object
    expect(config?.tools["__proto__"]).toEqual({ inputValues: false });
    expect(config?.tools.constructor).toEqual({ intent: false });
    expect(Object.hasOwn(config?.tools ?? {}, "inputValues")).toBe(false); // not poisoned
  });
});

describe("endpoint validation", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...without(originalEnv, "YAVIO_ENDPOINT"), YAVIO_API_KEY: "yav_test" };
    _resetConfigWarnings();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("treats an empty or whitespace-only endpoint as unset: the default, no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.YAVIO_ENDPOINT = ""; // what a compose file passes for an unset variable
    expect(resolveConfig()?.endpoint).toBe("https://ingest.yavio.ai/v1/events");
    expect(resolveConfig({ endpoint: "  " })?.endpoint).toBe("https://ingest.yavio.ai/v1/events");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("goes no-op for an endpoint that is not an http(s) URL — never the hosted default — with one YAVIO-1002 error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // A self-hosted integrator's typo must not reroute events and API key to
    // the hosted service.
    for (const endpoint of [
      "localhost:3001/v1/events", // parses, protocol "localhost:"
      "htps://ingest.example.com/v1/events",
      "ingest.example.com/v1/events",
      "ftp://ingest.example/v1/events",
    ]) {
      expect(resolveConfig({ endpoint })).toBeNull();
      expect(lastNoopReason()).toBe("invalid-endpoint");
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("YAVIO-1002");
    expect(error.mock.calls[0]?.[0]).toContain("no-op");
    // A valid endpoint afterwards resolves again, with no reason left behind.
    expect(resolveConfig({ endpoint: "http://127.0.0.1:3001/v1/events" })).not.toBeNull();
    expect(lastNoopReason()).toBeNull();
    error.mockRestore();
  });

  it("keeps a valid http(s) endpoint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({ endpoint: "http://127.0.0.1:3001/v1/events" })?.endpoint).toBe(
      "http://127.0.0.1:3001/v1/events",
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("boolean capture flags fail closed", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetConfigWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("leaves rejectedInputValues off by default and keeps a per-tool override (#123)", () => {
    const config = resolveConfig({
      apiKey: "test",
      tools: { pick: { rejectedInputValues: true } },
    });
    expect(config?.capture.rejectedInputValues).toBe(false);
    expect(config?.tools.pick).toEqual({ rejectedInputValues: true });
  });

  it.each([
    "inputValues",
    "outputValues",
    "conversationId",
    "tokens",
    "retries",
    "rejectedInputValues",
  ] as const)('turns %s off on the string "false", with one YAVIO-1006 warning', (flag) => {
    // Hand-written JSON: "false" is truthy and used to keep capture ON.
    const config = resolveConfig({ apiKey: "test", capture: { [flag]: "false" as never } });
    expect(config?.capture[flag]).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("YAVIO-1006");
    expect(warn.mock.calls[0][0]).toContain(`capture.${flag}`);
  });

  it("passes booleans through and warns once per flag, not once overall", () => {
    const config = resolveConfig({
      apiKey: "test",
      capture: { inputValues: "no" as never, outputValues: false, geo: "yes" as never },
    });
    expect(config?.capture.inputValues).toBe(false);
    expect(config?.capture.outputValues).toBe(false);
    expect(config?.capture.geo).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a hand-written "false" string for inputValues in .yaviorc.json', () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-flags-test-"));
    const originalCwd = process.cwd;
    try {
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({ apiKey: "file_key", capture: { inputValues: "false" } }),
      );
      process.cwd = () => tempDir;
      expect(resolveConfig()?.capture.inputValues).toBe(false);
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("capture.conversationId (#204)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetConfigWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("is on by default, also when set to undefined, and passes false through, without a warning", () => {
    expect(resolveConfig({ apiKey: "test" })?.capture.conversationId).toBe(true);
    // A computed option: `conversationId: strict ? false : undefined`.
    expect(
      resolveConfig({ apiKey: "test", capture: { conversationId: undefined } })?.capture
        .conversationId,
    ).toBe(true);
    expect(
      resolveConfig({ apiKey: "test", capture: { conversationId: false } })?.capture.conversationId,
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["no", "false", "true", 0, 1, null])(
    "fails closed on %j: false, with one YAVIO-1006 warning",
    (value) => {
      const config = resolveConfig({ apiKey: "test", capture: { conversationId: value as never } });
      expect(config?.capture.conversationId).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("YAVIO-1006");
      expect(warn.mock.calls[0][0]).toContain("capture.conversationId must be true or false");
    },
  );

  it("is read from .yaviorc.json like the other flags: code options win, an invalid value fails closed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-conversation-test-"));
    const originalCwd = process.cwd;
    const write = (capture: object) =>
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({ apiKey: "file_key", capture }),
      );
    try {
      process.cwd = () => tempDir;
      write({ conversationId: false });
      expect(resolveConfig()?.capture.conversationId).toBe(false);
      expect(resolveConfig({ capture: { conversationId: true } })?.capture.conversationId).toBe(
        true,
      );
      expect(warn).not.toHaveBeenCalled();
      write({ conversationId: "no" });
      expect(resolveConfig()?.capture.conversationId).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("capture.conversationId");
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a CaptureConfig typed without it, as before 0.5.6 (review round 1)", () => {
    // A type check as much as a test: the typecheck job fails here if the
    // public field is required again (TS2741 in a patch release).
    const capture: CaptureConfig = {
      inputValues: true,
      outputValues: true,
      geo: "country",
      tokens: true,
      retries: true,
      rejectedInputValues: false,
    };
    expect(resolveConfig({ apiKey: "test", capture })?.capture.conversationId).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["conversationId", "geo"] as const)(
    "has no per-tool %s: a tools entry setting it is ignored with one YAVIO-1006 line per tool (review round 1)",
    (flag) => {
      const tools = {
        pick: { [flag]: false } as never,
        book: { inputValues: false, [flag]: false } as never,
      };
      const config = resolveConfig({ apiKey: "test", tools });
      // Ignored: no entry for a tool that set nothing else, the rest kept,
      // the global value in force.
      expect(Object.hasOwn(config?.tools ?? {}, "pick")).toBe(false);
      expect(config?.tools.book).toEqual({ inputValues: false });
      expect(config?.capture[flag]).toBe(true);
      const lines = warn.mock.calls.map((args: unknown[]) => String(args[0]));
      expect(lines).toHaveLength(2);
      for (const [i, tool] of ["pick", "book"].entries()) {
        expect(lines[i]).toContain("YAVIO-1006");
        expect(lines[i]).toContain(`tools.${tool}.${flag} is ignored`);
        expect(lines[i]).toContain(`capture.${flag} applies`);
      }
      // Once per tool, flag and process: stateless servers resolve per request.
      resolveConfig({ apiKey: "test", tools });
      expect(warn).toHaveBeenCalledTimes(2);
    },
  );

  it("does not warn for a per-tool geo or conversationId equal to the global value (review round 2)", () => {
    const config = resolveConfig({
      apiKey: "test",
      capture: { geo: "country", conversationId: false },
      tools: {
        same: { geo: "country", conversationId: false } as never,
        other: { geo: "region", conversationId: true } as never,
      },
    });
    expect(config?.capture.geo).toBe("country");
    expect(config?.capture.conversationId).toBe(false);
    expect(Object.hasOwn(config?.tools ?? {}, "same")).toBe(false);
    expect(Object.hasOwn(config?.tools ?? {}, "other")).toBe(false);
    // Only the differing tool: the same value changes nothing.
    const lines = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tools.other.geo is ignored");
    expect(lines[1]).toContain("tools.other.conversationId is ignored");
  });

  it("warns for a per-tool conversationId in .yaviorc.json too, and the file's global value applies", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-conversation-tools-test-"));
    const originalCwd = process.cwd;
    try {
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({
          apiKey: "file_key",
          capture: { conversationId: false },
          tools: { pick: { conversationId: true } },
        }),
      );
      process.cwd = () => tempDir;
      const config = resolveConfig();
      expect(config?.capture.conversationId).toBe(false);
      expect(Object.hasOwn(config?.tools ?? {}, "pick")).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("tools.pick.conversationId is ignored");
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("capture.geo validation", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetConfigWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it.each([true, false, "country", "region"] as const)(
    "passes %s through without a warning",
    (geo) => {
      expect(resolveConfig({ apiKey: "test", capture: { geo } })?.capture.geo).toBe(geo);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("leaves an undefined geo at the default, without a warning", () => {
    // A computed option: `geo: process.env.GEO_COUNTRY ? "country" : undefined`.
    const config = resolveConfig({ apiKey: "test", capture: { geo: undefined } });
    expect(config?.capture.geo).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["false", "Country", "state", "Region", 1, null])(
    "fails closed on %j with one warning",
    (geo) => {
      const config = resolveConfig({ apiKey: "test", capture: { geo: geo as never } });
      expect(config?.capture.geo).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("YAVIO-1006");
      expect(warn.mock.calls[0][0]).toContain('true, false, "country" or "region"');
    },
  );

  it('accepts "region" from .yaviorc.json', () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-geo-test-"));
    const originalCwd = process.cwd;
    try {
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({ apiKey: "file_key", capture: { geo: "region" } }),
      );
      process.cwd = () => tempDir;
      expect(resolveConfig()?.capture.geo).toBe("region");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("warns once per process, not once per resolution", () => {
    for (let i = 0; i < 3; i++) {
      expect(resolveConfig({ apiKey: "test", capture: { geo: "yes" as never } })?.capture.geo).toBe(
        false,
      );
    }
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fails closed on a hand-written "false" string in .yaviorc.json', () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-geo-test-"));
    const originalCwd = process.cwd;
    try {
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({ apiKey: "file_key", capture: { geo: "false" } }),
      );
      process.cwd = () => tempDir;
      expect(resolveConfig()?.capture.geo).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("shutdownTimeoutMs (#142)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = without(originalEnv, "YAVIO_SHUTDOWN_TIMEOUT_MS");
    process.env.YAVIO_API_KEY = "yav_test";
    _resetConfigWarnings();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("defaults to 4 s (#148)", () => {
    expect(resolveConfig()?.shutdownTimeoutMs).toBe(4_000);
  });

  it("reads the code option", () => {
    expect(resolveConfig({ shutdownTimeoutMs: 7_000 })?.shutdownTimeoutMs).toBe(7_000);
  });

  it("reads YAVIO_SHUTDOWN_TIMEOUT_MS, and the code option wins over it", () => {
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "2500";
    expect(resolveConfig()?.shutdownTimeoutMs).toBe(2_500);
    expect(resolveConfig({ shutdownTimeoutMs: 7_000 })?.shutdownTimeoutMs).toBe(7_000);
  });

  it("an empty env var falls through to the default", () => {
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "";
    expect(resolveConfig()?.shutdownTimeoutMs).toBe(4_000);
    expect(resolveConfig()?.shutdownTimeoutMsSource).toBe("default");
  });

  it("reports the source: option, env, file or default (review round 3)", () => {
    expect(resolveConfig()?.shutdownTimeoutMsSource).toBe("default");
    expect(resolveConfig({ shutdownTimeoutMs: 7_000 })?.shutdownTimeoutMsSource).toBe("option");
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "2500";
    expect(resolveConfig()?.shutdownTimeoutMsSource).toBe("env");
    expect(resolveConfig({ shutdownTimeoutMs: 7_000 })?.shutdownTimeoutMsSource).toBe("option");
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-shutdown-source-test-"));
    const originalCwd = process.cwd;
    try {
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({ apiKey: "file_key", shutdownTimeoutMs: 3_000 }),
      );
      process.cwd = () => tempDir;
      expect(resolveConfig()?.shutdownTimeoutMsSource).toBe("env");
      process.env = without(process.env, "YAVIO_SHUTDOWN_TIMEOUT_MS");
      expect(resolveConfig()).toMatchObject({
        shutdownTimeoutMs: 3_000,
        shutdownTimeoutMsSource: "file",
      });
      // A rejected value is the default, not the file's value, and says so:
      // the signal drain must not take it for a bound someone chose.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "soon";
      expect(resolveConfig()).toMatchObject({
        shutdownTimeoutMs: 4_000,
        shutdownTimeoutMsSource: "default",
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shutdownTimeoutFromEnv(): the env var as an explicit value, undefined when unset, empty or rejected (#148)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(shutdownTimeoutFromEnv()).toBeUndefined();
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "";
    expect(shutdownTimeoutFromEnv()).toBeUndefined();
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "2500";
    expect(shutdownTimeoutFromEnv()).toBe(2_500);
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "soon";
    expect(shutdownTimeoutFromEnv()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts both bounds: 100 and 2147483647", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({ shutdownTimeoutMs: 100 })?.shutdownTimeoutMs).toBe(100);
    expect(resolveConfig({ shutdownTimeoutMs: 2_147_483_647 })?.shutdownTimeoutMs).toBe(
      2_147_483_647,
    );
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "100";
    expect(resolveConfig()?.shutdownTimeoutMs).toBe(100);
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "2147483647";
    expect(resolveConfig()?.shutdownTimeoutMs).toBe(2_147_483_647);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    "0",
    "-1",
    "soon",
    "NaN",
    "99",
    "2147483648",
    "9007199254740991",
    "Infinity",
    "1500.5",
    // Strings Number() would take: only decimal digits are a number (review round 2).
    "0x2710",
    "1e4",
    "+2500",
    " 2500 ms",
  ])("rejects %s with one warning and uses the default", (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = value;
    expect(resolveConfig()?.shutdownTimeoutMs).toBe(4_000);
    expect(resolveConfig()).toMatchObject({
      shutdownTimeoutMs: 4_000,
      shutdownTimeoutMsSource: "default",
    });
    const lines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("shutdownTimeoutMs"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("YAVIO-1006");
  });

  it.each(["0x2710", "1e4"])("rejects the string %s in .yaviorc.json the same way", (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-shutdown-test-"));
    const originalCwd = process.cwd;
    try {
      writeFileSync(
        join(tempDir, ".yaviorc.json"),
        JSON.stringify({ apiKey: "file_key", shutdownTimeoutMs: value }),
      );
      process.cwd = () => tempDir;
      expect(resolveConfig()?.shutdownTimeoutMs).toBe(4_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("YAVIO-1006");
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a zero code option the same way", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({ shutdownTimeoutMs: 0 })?.shutdownTimeoutMs).toBe(4_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("between 100 and 2147483647");
  });

  it.each([99, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, 0.5, 250.25])(
    "rejects the out-of-range or non-integer code option %s",
    (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(resolveConfig({ shutdownTimeoutMs: value })?.shutdownTimeoutMs).toBe(4_000);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe("sessionKey (#144)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = without(originalEnv);
    process.env.YAVIO_API_KEY = "yav_test";
    _resetConfigWarnings();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("accepts a function, unchanged, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sessionKey = ({ headers }: { headers: Record<string, string | undefined> }) =>
      headers["x-conversation-id"];
    expect(resolveConfig({ sessionKey })?.sessionKey).toBe(sessionKey);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves it unset when not given", () => {
    expect(resolveConfig()?.sessionKey).toBeUndefined();
  });

  it.each([
    ["a header name instead of a callback", "x-conversation-id"],
    ["null", null],
    ["an object", { header: "x-conversation-id" }],
    ["a number", 1],
  ])("ignores %s with one YAVIO-1006 warning per process", (_label, value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const options = { sessionKey: value } as unknown as Parameters<typeof resolveConfig>[0];
    expect(resolveConfig(options)?.sessionKey).toBeUndefined();
    expect(resolveConfig(options)?.sessionKey).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("YAVIO-1006");
    expect(line).toContain("sessionKey must be a function");
    // The type, never the value.
    expect(line).not.toContain("x-conversation-id");
  });

  it("is not read from .yaviorc.json: a function cannot be written there", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yavio-config-test-"));
    writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify({ sessionKey: "x-conv" }));
    const originalCwd = process.cwd;
    process.cwd = () => tempDir;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveConfig()?.sessionKey).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.cwd = originalCwd;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
