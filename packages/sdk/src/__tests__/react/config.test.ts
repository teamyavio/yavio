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

  it("resolves from _meta.yavio in tool result", () => {
    const config = resolveWidgetConfig({
      _meta: {
        yavio: {
          token: "jwt_tool",
          endpoint: "http://tool/v1/events",
          traceId: "tr_tool",
          sessionId: "ses_tool",
        },
      },
    });
    expect(config).toEqual({
      token: "jwt_tool",
      endpoint: "http://tool/v1/events",
      traceId: "tr_tool",
      sessionId: "ses_tool",
    });
  });

  it("ignores incomplete _meta.yavio", () => {
    const config = resolveWidgetConfig({
      _meta: { yavio: { token: "only" } },
    });
    expect(config).toBeNull();
  });

  it("prefers _meta.yavio over explicit fields", () => {
    const config = resolveWidgetConfig({
      token: "jwt_explicit",
      endpoint: "http://explicit/v1/events",
      traceId: "tr_explicit",
      sessionId: "ses_explicit",
      _meta: {
        yavio: {
          token: "jwt_meta_yavio",
          endpoint: "http://meta_yavio/v1/events",
          traceId: "tr_meta_yavio",
          sessionId: "ses_meta_yavio",
        },
      },
    });
    expect(config?.token).toBe("jwt_meta_yavio");
  });

  it("resolves from .yavio in responseMetadata (Skybridge)", () => {
    const config = resolveWidgetConfig({
      products: [{ id: "1" }],
      yavio: {
        token: "jwt_sky",
        endpoint: "http://sky/v1/events",
        traceId: "tr_sky",
        sessionId: "ses_sky",
      },
    });
    expect(config).toEqual({
      token: "jwt_sky",
      endpoint: "http://sky/v1/events",
      traceId: "tr_sky",
      sessionId: "ses_sky",
    });
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
