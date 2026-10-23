import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../core/types.js";
import {
  type RequestStore,
  _resetContextWarnings,
  createYavioContext,
  getStore,
  markSdkActive,
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
    it("identify, step, track and conversion carry the session's session_source (#144)", () => {
      for (const sessionSource of ["custom", "per_request"] as const) {
        const transport = createMockTransport();
        const store = createStore({ transport, session: createSession({ sessionSource }) });
        const ctx = createYavioContext();
        runInContext(store, () => {
          ctx.identify("user-1");
          ctx.step("checkout");
          ctx.track("viewed");
          ctx.conversion("purchase", { value: 10, currency: "EUR" });
        });
        const events = transport.sent.flat();
        expect(events.map((e) => e.event_type)).toEqual([
          "identify",
          "step",
          "track",
          "conversion",
        ]);
        expect(events.map((e) => e.session_source)).toEqual([
          sessionSource,
          sessionSource,
          sessionSource,
          sessionSource,
        ]);
      }
    });

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

      describe("once per session state (#145)", () => {
        const identifies = (transport: ReturnType<typeof createMockTransport>) =>
          transport.sent.flat().filter((e) => e.event_type === "identify") as Array<
            BaseEvent & { user_traits?: Record<string, unknown> }
          >;

        it("the same id twice sends one event", () => {
          // Before: one event per call — and the docs recommend calling
          // identify() in every handler, so one identify row per tool call.
          const transport = createMockTransport();
          const store = createStore({ transport });
          const ctx = createYavioContext();
          runInContext(store, () => {
            ctx.identify("user-1");
            ctx.identify("user-1");
          });
          expect(identifies(transport)).toHaveLength(1);
          expect(identifies(transport)[0]?.user_id).toBe("user-1");
        });

        it("the same traits written in another order send one event", () => {
          const transport = createMockTransport();
          const store = createStore({ transport });
          const ctx = createYavioContext();
          runInContext(store, () => {
            ctx.identify("user-1", { plan: "pro", region: "EU" });
            ctx.identify("user-1", { region: "EU", plan: "pro" });
          });
          expect(identifies(transport)).toHaveLength(1);
        });

        it("a changed trait sends again with the merged traits, a repeat of it sends nothing, and a trait set back sends again", () => {
          const transport = createMockTransport();
          const store = createStore({ transport });
          const ctx = createYavioContext();
          runInContext(store, () => {
            ctx.identify("user-1", { plan: "free", region: "EU" });
            ctx.identify("user-1", { plan: "pro" });
            ctx.identify("user-1", { plan: "pro" });
            ctx.identify("user-1", { plan: "free" });
          });
          // Compared with the last event sent, not with every one seen.
          expect(identifies(transport).map((e) => e.user_traits)).toEqual([
            { plan: "free", region: "EU" },
            { plan: "pro", region: "EU" },
            { plan: "free", region: "EU" },
          ]);
        });

        it("a conflicting id sends nothing and warns once (YAVIO-1302); the first id again sends nothing either", () => {
          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          try {
            const transport = createMockTransport();
            const store = createStore({ transport });
            const ctx = createYavioContext();
            runInContext(store, () => {
              ctx.identify("user-1");
              ctx.identify("user-2");
              ctx.identify("user-1");
            });
            expect(identifies(transport).map((e) => e.user_id)).toEqual(["user-1"]);
            const conflicts = warnSpy.mock.calls.filter((c) => String(c[0]).includes("YAVIO-1302"));
            expect(conflicts).toHaveLength(1);
          } finally {
            warnSpy.mockRestore();
          }
        });

        it("a trait with no JSON form (a BigInt) sends as before, never throws, and keeps no fingerprint: the next serialisable call sends", () => {
          const transport = createMockTransport();
          const store = createStore({ transport });
          const ctx = createYavioContext();
          runInContext(store, () => {
            ctx.identify("user-1", { seats: 1 });
            expect(() => ctx.identify("user-1", { seats: 2n })).not.toThrow();
            expect(() => ctx.identify("user-1", { seats: 2n })).not.toThrow();
            // The last event sent had the BigInt: { seats: 1 } is a change.
            ctx.identify("user-1", { seats: 1 });
            ctx.identify("user-1", { seats: 1 });
          });
          expect(identifies(transport).map((e) => e.user_traits?.seats)).toEqual([1, 2n, 2n, 1]);
        });

        it("a circular trait never throws, and its repeat sends nothing (the PII walk replaces the cycle)", () => {
          const transport = createMockTransport();
          const store = createStore({ transport });
          const ctx = createYavioContext();
          const company: Record<string, unknown> = { name: "Acme" };
          company.self = company;
          runInContext(store, () => {
            expect(() => ctx.identify("user-1", { company })).not.toThrow();
            ctx.identify("user-1", { company });
          });
          expect(identifies(transport)).toHaveLength(1);
          expect(identifies(transport)[0]?.user_traits).toEqual({
            company: { name: "Acme", self: "[Circular]" },
          });
        });

        it("a fresh state for the same session — after an LRU eviction, or in another process — sends again", () => {
          const transport = createMockTransport();
          const ctx = createYavioContext();
          const before = createStore({ transport });
          runInContext(before, () => {
            ctx.identify("user-1", { plan: "pro" });
            ctx.identify("user-1", { plan: "pro" });
          });
          const after = createStore({ transport, session: createSession() });
          runInContext(after, () => {
            ctx.identify("user-1", { plan: "pro" });
            ctx.identify("user-1", { plan: "pro" });
          });
          expect(identifies(transport).map((e) => e.session_id)).toEqual(["ses_test", "ses_test"]);
        });
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

describe("tracking calls outside a wrapped tool call", () => {
  beforeEach(() => _resetContextWarnings());
  afterEach(() => _resetContextWarnings());

  it("stays silent while the SDK is not active (no-op mode)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createYavioContext();
    ctx.track("orphan");
    ctx.conversion("sale", { value: 10, currency: "USD" });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("drops the event and warns once per process with YAVIO-1105 once active", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    markSdkActive();
    const ctx = createYavioContext();
    ctx.conversion("booking_received", { value: 99, currency: "EUR" });
    ctx.track("orphan");
    ctx.step("s");
    ctx.identify("u");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain("[YAVIO-1105]");
    expect(message).toContain("yavio.conversion()");
    expect(message).toContain("event dropped");
    expect(message).toContain("withYavio()");
    warnSpy.mockRestore();
  });

  it("does not warn when a store is active", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    markSdkActive();
    const transport = createMockTransport();
    const ctx = createYavioContext();
    runInContext(createStore({ transport }), () => {
      ctx.conversion("booking_received", { value: 99, currency: "EUR" });
    });
    expect(transport.sent).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
