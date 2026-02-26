import { describe, expect, it } from "vitest";
import { resolveWidgetConfig } from "../../react/config.js";

describe("resolveWidgetConfig", () => {
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
});
