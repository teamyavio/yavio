import {
  ConversionEvent,
  IdentifyEvent,
  StepEvent,
  ToolCallEvent,
  TrackEvent,
} from "@yavio/shared/events";
import { describe, expect, it } from "vitest";
import {
  type EventContext,
  buildConversionEvent,
  buildIdentifyEvent,
  buildStepEvent,
  buildToolCallEvent,
  buildTrackEvent,
} from "../core/events.js";

const ctx: EventContext = {
  traceId: "tr_test123",
  sessionId: "ses_test456",
  userId: "user-1",
  platform: "claude",
  sdkVersion: "0.0.1",
};

describe("Event factories", () => {
  describe("buildIdentifyEvent", () => {
    it("produces a valid IdentifyEvent", () => {
      const event = buildIdentifyEvent(ctx, "user-1", { plan: "pro" });
      expect(IdentifyEvent.safeParse(event).success).toBe(true);
    });

    it("sets user_id and user_traits", () => {
      const event = buildIdentifyEvent(ctx, "user-1", { plan: "pro" });
      expect(event.user_id).toBe("user-1");
      expect(event.user_traits).toEqual({ plan: "pro" });
    });

    it("strips PII from traits", () => {
      const event = buildIdentifyEvent(ctx, "user-1", { email: "test@example.com" });
      expect(event.user_traits?.email).toBe("[EMAIL_REDACTED]");
    });
  });

  describe("buildStepEvent", () => {
    it("produces a valid StepEvent", () => {
      const event = buildStepEvent(ctx, "rooms_found", 1, { count: 5 });
      expect(StepEvent.safeParse(event).success).toBe(true);
    });

    it("includes step_sequence and event_name", () => {
      const event = buildStepEvent(ctx, "rooms_found", 3);
      expect(event.event_name).toBe("rooms_found");
      expect(event.step_sequence).toBe(3);
    });
  });

  describe("buildTrackEvent", () => {
    it("produces a valid TrackEvent", () => {
      const event = buildTrackEvent(ctx, "button_clicked", { id: "submit" });
      expect(TrackEvent.safeParse(event).success).toBe(true);
    });

    it("strips PII from properties", () => {
      const event = buildTrackEvent(ctx, "contact", { phone: "555-123-4567" });
      expect(event.metadata?.phone).toBe("[PHONE_REDACTED]");
    });
  });

  describe("buildConversionEvent", () => {
    it("produces a valid ConversionEvent", () => {
      const event = buildConversionEvent(ctx, "booking", 567, "EUR");
      expect(ConversionEvent.safeParse(event).success).toBe(true);
    });

    it("includes value and currency", () => {
      const event = buildConversionEvent(ctx, "booking", 99.99, "USD");
      expect(event.conversion_value).toBe(99.99);
      expect(event.conversion_currency).toBe("USD");
    });
  });

  describe("buildToolCallEvent", () => {
    it("produces a valid ToolCallEvent", () => {
      const event = buildToolCallEvent(ctx, {
        toolName: "search_rooms",
        latencyMs: 123,
        status: "success",
      });
      expect(ToolCallEvent.safeParse(event).success).toBe(true);
    });

    it("includes error fields on failure", () => {
      const event = buildToolCallEvent(ctx, {
        toolName: "book_room",
        status: "error",
        errorCategory: "validation",
        errorMessage: "Invalid room ID",
      });
      expect(event.status).toBe("error");
      expect(event.error_category).toBe("validation");
      expect(event.error_message).toBe("Invalid room ID");
    });

    it("strips PII from input_keys", () => {
      const event = buildToolCallEvent(ctx, {
        toolName: "search",
        inputKeys: { query: "email is test@example.com" },
      });
      expect(event.input_keys?.query).toBe("email is [EMAIL_REDACTED]");
    });

    it("populates input_types separately from input_keys", () => {
      const event = buildToolCallEvent(ctx, {
        toolName: "search",
        inputKeys: { checkin: true, guests: true },
        inputTypes: { checkin: "string", guests: "number" },
      });
      expect(event.input_keys).toEqual({ checkin: true, guests: true });
      expect(event.input_types).toEqual({ checkin: "string", guests: "number" });
    });

    it("strips PII from input_values", () => {
      const event = buildToolCallEvent(ctx, {
        toolName: "search",
        inputValues: { query: "contact test@example.com" },
      });
      expect(event.input_values?.query).toBe("contact [EMAIL_REDACTED]");
    });

    it("strips PII from output_content text content", () => {
      const event = buildToolCallEvent(ctx, {
        toolName: "search",
        outputContent: {
          content: [{ type: "text", text: "email is test@example.com" }],
        },
      });
      const content = event.output_content?.content as Array<Record<string, unknown>>;
      expect(content[0].text).toBe("email is [EMAIL_REDACTED]");
    });

    it("strips PII from output_content structuredContent", () => {
      const event = buildToolCallEvent(ctx, {
        toolName: "search",
        outputContent: {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { email: "test@example.com", name: "Alice" },
        },
      });
      const structured = event.output_content?.structuredContent as Record<string, unknown>;
      expect(structured.email).toBe("[EMAIL_REDACTED]");
      expect(structured.name).toBe("Alice");
    });
  });

  describe("common fields", () => {
    it("all events have valid UUIDs", () => {
      const event = buildTrackEvent(ctx, "test");
      expect(event.event_id).toMatch(/^[0-9a-f]{8}-/);
    });

    it("all events have ISO timestamps", () => {
      const event = buildTrackEvent(ctx, "test");
      expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
    });

    it("all events have source: server", () => {
      const event = buildTrackEvent(ctx, "test");
      expect(event.source).toBe("server");
    });

    it("all events include session and trace IDs", () => {
      const event = buildTrackEvent(ctx, "test");
      expect(event.trace_id).toBe("tr_test123");
      expect(event.session_id).toBe("ses_test456");
    });
  });
});
