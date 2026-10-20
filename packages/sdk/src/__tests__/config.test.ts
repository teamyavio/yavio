import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetConfigWarnings, resolveConfig } from "../core/config.js";

describe("resolveConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.YAVIO_API_KEY = undefined;
    process.env.YAVIO_ENDPOINT = undefined;
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
    process.env = { ...originalEnv };
    process.env.YAVIO_API_KEY = undefined;
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

  it.each(["inputValues", "outputValues", "tokens", "retries", "rejectedInputValues"] as const)(
    'turns %s off on the string "false", with one YAVIO-1006 warning',
    (flag) => {
      // Hand-written JSON: "false" is truthy and used to keep capture ON.
      const config = resolveConfig({ apiKey: "test", capture: { [flag]: "false" as never } });
      expect(config?.capture[flag]).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("YAVIO-1006");
      expect(warn.mock.calls[0][0]).toContain(`capture.${flag}`);
    },
  );

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
