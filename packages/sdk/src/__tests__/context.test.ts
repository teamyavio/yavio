import type { BaseEvent } from "@yavio/shared/events";
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../core/types.js";
import {
  type RequestStore,
  createYavioContext,
  getStore,
  runInContext,
} from "../server/context.js";
import type { Transport } from "../transport/types.js";

function createMockTransport(): Transport & { sent: BaseEvent[][] } {
  const sent: BaseEvent[][] = [];
  return {
    sent,
    send(events: BaseEvent[]) {
      sent.push(events);
    },
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "ses_test",
    userId: null,
    userTraits: {},
    platform: "unknown",
    stepSequence: 0,
    ...overrides,
  };
}

function createStore(overrides: Partial<RequestStore> = {}): RequestStore {
  return {
    traceId: "tr_test",
    session: createSession(),
    transport: createMockTransport(),
    sdkVersion: "0.0.1",
    ...overrides,
  };
}

describe("AsyncLocalStorage context", () => {
  describe("runInContext / getStore", () => {
    it("provides the store within context", () => {
      const store = createStore();
      runInContext(store, () => {
        expect(getStore()).toBe(store);
      });
    });

    it("returns undefined outside context", () => {
      expect(getStore()).toBeUndefined();
    });
  });

  describe("createYavioContext", () => {
    describe(".identify()", () => {
      it("sets userId on session state", () => {
        const store = createStore();
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.identify("user-1");
        });
        expect(store.session.userId).toBe("user-1");
      });

      it("emits an identify event", () => {
        const transport = createMockTransport();
        const store = createStore({ transport });
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.identify("user-1", { plan: "pro" });
        });
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0][0].event_type).toBe("identify");
      });

      it("merges traits on repeated calls with same userId", () => {
        const store = createStore();
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.identify("user-1", { plan: "pro" });
          ctx.identify("user-1", { region: "EU" });
        });
        expect(store.session.userTraits).toEqual({ plan: "pro", region: "EU" });
      });

      it("warns and ignores when userId changes within session", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const store = createStore();
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.identify("user-1");
          ctx.identify("user-2");
        });
        expect(store.session.userId).toBe("user-1");
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignoring"));
        warnSpy.mockRestore();
      });
    });

    describe(".step()", () => {
      it("increments step_sequence", () => {
        const transport = createMockTransport();
        const store = createStore({ transport });
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.step("first");
          ctx.step("second");
        });
        expect(store.session.stepSequence).toBe(2);
        expect(transport.sent[0][0]).toMatchObject({ event_type: "step" });
        expect(transport.sent[1][0]).toMatchObject({ event_type: "step" });
      });
    });

    describe(".track()", () => {
      it("sends a track event", () => {
        const transport = createMockTransport();
        const store = createStore({ transport });
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.track("button_click", { id: "submit" });
        });
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0][0]).toMatchObject({
          event_type: "track",
          event_name: "button_click",
        });
      });
    });

    describe(".conversion()", () => {
      it("sends a conversion event with value and currency", () => {
        const transport = createMockTransport();
        const store = createStore({ transport });
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.conversion("booking", { value: 99.99, currency: "USD" });
        });
        expect(transport.sent).toHaveLength(1);
        const event = transport.sent[0][0] as Record<string, unknown>;
        expect(event.event_type).toBe("conversion");
        expect(event.conversion_value).toBe(99.99);
        expect(event.conversion_currency).toBe("USD");
      });
    });

    describe("user_id propagation", () => {
      it("events before identify have no user_id", () => {
        const transport = createMockTransport();
        const store = createStore({ transport });
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.track("before_identify");
        });
        expect(transport.sent[0][0].user_id).toBeUndefined();
      });

      it("events after identify have correct user_id", () => {
        const transport = createMockTransport();
        const store = createStore({ transport });
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.identify("user-1");
          ctx.track("after_identify");
        });
        // second event (track) should have user_id
        expect(transport.sent[1][0].user_id).toBe("user-1");
      });
    });

    describe("outside context", () => {
      it("is a no-op when no store is available", () => {
        const ctx = createYavioContext();
        // Should not throw
        ctx.track("orphan_event");
        ctx.identify("user-1");
        ctx.step("step-1");
        ctx.conversion("sale", { value: 10, currency: "USD" });
      });
    });
  });
});
