import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@yavio/shared/error-codes";
import type { IdentifyEvent } from "@yavio/shared/events";
import {
  type EventContext,
  buildConversionEvent,
  buildIdentifyEvent,
  buildStepEvent,
  buildTrackEvent,
} from "../core/events.js";
import { stable } from "../core/stable.js";
import type { SessionState, YavioContext } from "../core/types.js";
import type { Transport } from "../transport/types.js";

export interface RequestStore {
  traceId: string;
  session: SessionState;
  transport: Transport;
  sdkVersion: string;
}

/** Global AsyncLocalStorage for per-request context. */
export const requestStore = new AsyncLocalStorage<RequestStore>();

/** Run a function within a request context. */
export function runInContext<T>(store: RequestStore, fn: () => T): T {
  return requestStore.run(store, fn);
}

/** Get the current request store, or undefined if outside context. */
export function getStore(): RequestStore | undefined {
  return requestStore.getStore();
}

/**
 * Set once `withYavio()` has resolved a configuration. Until then a tracking
 * call with no active store is expected — no-op mode (no API key), or a call
 * made before `withYavio()` ran — and stays silent; afterwards it is a bug
 * worth one warning (see droppedOutsideContext).
 */
let sdkActive = false;
let warnedOutsideContext = false;

export function markSdkActive(): void {
  sdkActive = true;
}

/** @internal Reset the warn-once state — exposed for testing only. */
export function _resetContextWarnings(): void {
  sdkActive = false;
  warnedOutsideContext = false;
}

/**
 * A `yavio.*` call with no request store is dropped — it has no trace or
 * session to attach to. That used to be silent, and the silence is how a
 * booking tool registered on the unwrapped server lost every conversion for
 * weeks without a hint (an integration, 2026-08). Warn once per process.
 */
function droppedOutsideContext(method: string): void {
  if (!sdkActive || warnedOutsideContext) return;
  warnedOutsideContext = true;
  console.warn(
    `[${ErrorCode.SDK.CONTEXT_INJECTION_UNAVAILABLE}] yavio.${method}() called outside a wrapped tool call — event dropped. Register the tool through withYavio() (use the \`tools\` overrides to limit what is captured for it). Shown once per process.`,
  );
}

/**
 * `[user_id, user_traits]` of an identify event as stable JSON (keys sorted,
 * so the order the traits were written in does not matter), or undefined
 * when it cannot be computed — a BigInt trait: such an event is sent as it
 * always was, and no fingerprint is kept for the next call to match.
 */
function identifyFingerprint(event: IdentifyEvent): string | undefined {
  try {
    return JSON.stringify(stable([event.user_id, event.user_traits ?? null]));
  } catch {
    return undefined;
  }
}

function buildCtx(store: RequestStore): EventContext {
  return {
    traceId: store.traceId,
    sessionId: store.session.sessionId,
    userId: store.session.userId ?? undefined,
    platform: store.session.platform,
    sdkVersion: store.sdkVersion,
    // The call's session, so identify/step/track/conversion say how it was
    // derived like the call's tool_call does (#144).
    sessionSource: store.session.sessionSource,
  };
}

/** Create a YavioContext that reads from the current AsyncLocalStorage store. */
export function createYavioContext(fallbackStore?: RequestStore): YavioContext {
  function getActiveStore(): RequestStore | undefined {
    return requestStore.getStore() ?? fallbackStore;
  }

  return {
    identify(userId: string, traits?: Record<string, unknown>): void {
      const store = getActiveStore();
      if (!store) {
        droppedOutsideContext("identify");
        return;
      }

      if (store.session.userId && store.session.userId !== userId) {
        console.warn(
          `[${ErrorCode.SDK.IDENTIFY_USER_ID_CONFLICT}] userId already set to "${store.session.userId}", ignoring "${userId}"`,
        );
        return;
      }

      store.session.userId = userId;
      if (traits) {
        store.session.userTraits = { ...store.session.userTraits, ...traits };
      }

      const event = buildIdentifyEvent(buildCtx(store), userId, store.session.userTraits);
      // Once per session state (#145): the docs have always told integrators
      // to call identify() in every handler, and every call sent an event.
      // A repeat with the same id and traits sends nothing; a changed trait
      // sends the merged traits. Per process and per state: after an LRU
      // eviction, or on another instance, the state is fresh and sends once.
      const fingerprint = identifyFingerprint(event);
      if (fingerprint !== undefined && fingerprint === store.session.identified) return;
      store.session.identified = fingerprint;
      store.transport.send([event]);
    },

    step(name: string, meta?: Record<string, unknown>): void {
      const store = getActiveStore();
      if (!store) {
        droppedOutsideContext("step");
        return;
      }

      store.session.stepSequence += 1;
      const event = buildStepEvent(buildCtx(store), name, store.session.stepSequence, meta);
      store.transport.send([event]);
    },

    track(eventName: string, properties?: Record<string, unknown>): void {
      const store = getActiveStore();
      if (!store) {
        droppedOutsideContext("track");
        return;
      }

      const event = buildTrackEvent(buildCtx(store), eventName, properties);
      store.transport.send([event]);
    },

    conversion(
      name: string,
      data: { value: number; currency: string; meta?: Record<string, unknown> },
    ): void {
      const store = getActiveStore();
      if (!store) {
        droppedOutsideContext("conversion");
        return;
      }

      const event = buildConversionEvent(
        buildCtx(store),
        name,
        data.value,
        data.currency,
        data.meta,
      );
      store.transport.send([event]);
    },
  };
}
