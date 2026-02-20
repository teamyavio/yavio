import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@yavio/shared/error-codes";
import {
  type EventContext,
  buildConversionEvent,
  buildIdentifyEvent,
  buildStepEvent,
  buildTrackEvent,
} from "../core/events.js";
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

function buildCtx(store: RequestStore): EventContext {
  return {
    traceId: store.traceId,
    sessionId: store.session.sessionId,
    userId: store.session.userId ?? undefined,
    platform: store.session.platform,
    sdkVersion: store.sdkVersion,
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
      if (!store) return;

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
      store.transport.send([event]);
    },

    step(name: string, meta?: Record<string, unknown>): void {
      const store = getActiveStore();
      if (!store) return;

      store.session.stepSequence += 1;
      const event = buildStepEvent(buildCtx(store), name, store.session.stepSequence, meta);
      store.transport.send([event]);
    },

    track(eventName: string, properties?: Record<string, unknown>): void {
      const store = getActiveStore();
      if (!store) return;

      const event = buildTrackEvent(buildCtx(store), eventName, properties);
      store.transport.send([event]);
    },

    conversion(
      name: string,
      data: { value: number; currency: string; meta?: Record<string, unknown> },
    ): void {
      const store = getActiveStore();
      if (!store) return;

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
