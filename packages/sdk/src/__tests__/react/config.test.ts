import { afterEach, describe, expect, it } from "vitest";
import { resolveWidgetConfig } from "../../react/config.js";

describe("resolveWidgetConfig", () => {
  afterEach(() => {
    window.__YAVIO__ = undefined;
    for (const el of document.head.querySelectorAll('meta[name="yavio-config"]')) {
      el.remove();
    }
  });

  it("resolves from window.__YAVIO__", () => {
    window.__YAVIO__ = {
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_abc",
      sessionId: "ses_xyz",
    };

    const config = resolveWidgetConfig();
    expect(config).toEqual({
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_abc",
      sessionId: "ses_xyz",
    });
  });

  it("deletes window.__YAVIO__ after reading (XSS mitigation)", () => {
    window.__YAVIO__ = {
      token: "jwt_test",
      endpoint: "http://test/v1/events",
      traceId: "tr_abc",
      sessionId: "ses_xyz",
    };

    resolveWidgetConfig();
    expect(window.__YAVIO__).toBeUndefined();
  });

  it("resolves from <meta> tag when window.__YAVIO__ absent", () => {
    const meta = document.createElement("meta");
    meta.name = "yavio-config";
    meta.content = JSON.stringify({
      token: "jwt_meta",
      endpoint: "http://meta/v1/events",
      traceId: "tr_meta",
      sessionId: "ses_meta",
    });
    document.head.appendChild(meta);

    const config = resolveWidgetConfig();
    expect(config).toEqual({
      token: "jwt_meta",
      endpoint: "http://meta/v1/events",
      traceId: "tr_meta",
      sessionId: "ses_meta",
    });
  });

  it("ignores invalid JSON in <meta> tag", () => {
    const meta = document.createElement("meta");
    meta.name = "yavio-config";
    meta.content = "not-json";
    document.head.appendChild(meta);

    const config = resolveWidgetConfig();
    expect(config).toBeNull();
  });

  it("ignores incomplete <meta> tag config", () => {
    const meta = document.createElement("meta");
    meta.name = "yavio-config";
    meta.content = JSON.stringify({ token: "jwt_only" });
    document.head.appendChild(meta);

    const config = resolveWidgetConfig();
    expect(config).toBeNull();
  });

  it("resolves from explicit options", () => {
    const config = resolveWidgetConfig({
      token: "jwt_explicit",
      endpoint: "http://explicit/v1/events",
      traceId: "tr_explicit",
      sessionId: "ses_explicit",
    });
    expect(config).toEqual({
      token: "jwt_explicit",
      endpoint: "http://explicit/v1/events",
      traceId: "tr_explicit",
      sessionId: "ses_explicit",
    });
  });

  it("ignores incomplete explicit options", () => {
    const config = resolveWidgetConfig({ token: "only_token" });
    expect(config).toBeNull();
  });

  it("returns null when no config found (no-op mode)", () => {
    const config = resolveWidgetConfig();
    expect(config).toBeNull();
  });

  it("prefers window.__YAVIO__ over meta tag", () => {
    window.__YAVIO__ = {
      token: "jwt_win",
      endpoint: "http://win/v1/events",
      traceId: "tr_win",
      sessionId: "ses_win",
    };
    const meta = document.createElement("meta");
    meta.name = "yavio-config";
    meta.content = JSON.stringify({
      token: "jwt_meta",
      endpoint: "http://meta/v1/events",
      traceId: "tr_meta",
      sessionId: "ses_meta",
    });
    document.head.appendChild(meta);

    const config = resolveWidgetConfig();
    expect(config?.token).toBe("jwt_win");
  });
});
