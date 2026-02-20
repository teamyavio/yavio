import { describe, expect, it } from "vitest";
import { extractWidgetConfig } from "../../react/extract.js";

describe("extractWidgetConfig", () => {
  it("extracts valid config from _meta.yavio", () => {
    const result = extractWidgetConfig({
      _meta: {
        yavio: {
          token: "jwt_123",
          endpoint: "http://test/v1/events",
          traceId: "tr_abc",
          sessionId: "ses_xyz",
        },
      },
    });

    expect(result).toEqual({
      token: "jwt_123",
      endpoint: "http://test/v1/events",
      traceId: "tr_abc",
      sessionId: "ses_xyz",
    });
  });

  it("returns null when _meta is missing", () => {
    expect(extractWidgetConfig({})).toBeNull();
  });

  it("returns null when _meta.yavio is missing", () => {
    expect(extractWidgetConfig({ _meta: {} })).toBeNull();
  });

  it("returns null when _meta.yavio is not an object", () => {
    expect(extractWidgetConfig({ _meta: { yavio: "not_an_object" } })).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(
      extractWidgetConfig({
        _meta: {
          yavio: {
            token: "jwt_123",
            endpoint: "http://test/v1/events",
            // missing traceId and sessionId
          },
        },
      }),
    ).toBeNull();
  });

  it("returns null when fields have wrong types", () => {
    expect(
      extractWidgetConfig({
        _meta: {
          yavio: {
            token: 123,
            endpoint: "http://test/v1/events",
            traceId: "tr_abc",
            sessionId: "ses_xyz",
          },
        },
      }),
    ).toBeNull();
  });

  it("extracts valid config from .yavio (Skybridge responseMetadata)", () => {
    const result = extractWidgetConfig({
      products: [{ id: "1" }],
      yavio: {
        token: "jwt_skybridge",
        endpoint: "http://test/v1/events",
        traceId: "tr_sky",
        sessionId: "ses_sky",
      },
    });

    expect(result).toEqual({
      token: "jwt_skybridge",
      endpoint: "http://test/v1/events",
      traceId: "tr_sky",
      sessionId: "ses_sky",
    });
  });

  it("returns null for null input", () => {
    expect(extractWidgetConfig(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractWidgetConfig(undefined)).toBeNull();
  });

  it("ignores extra fields in yavio config", () => {
    const result = extractWidgetConfig({
      _meta: {
        yavio: {
          token: "jwt_123",
          endpoint: "http://test/v1/events",
          traceId: "tr_abc",
          sessionId: "ses_xyz",
          extraField: "ignored",
        },
      },
    });

    expect(result).toEqual({
      token: "jwt_123",
      endpoint: "http://test/v1/events",
      traceId: "tr_abc",
      sessionId: "ses_xyz",
    });
  });
});
