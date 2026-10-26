import { MAX_BATCH_EVENTS } from "@yavio/shared/events";

/**
 * The largest text/plain body the events route reads: sendBeacon's own
 * quota. Only a beacon may carry its token in the body, and only as
 * text/plain, so this is also the most a request that has not yet
 * authenticated can make ingest read. The React SDK splits beacons at
 * 60,000 bytes.
 */
export const BEACON_BODY_LIMIT = 64 * 1024;

/**
 * The largest JSON body the events route reads: the 500 KB batch limit
 * (field-limits.ts, checked on the parsed batch) plus room for formatting.
 * Longer bodies get 413 (YAVIO-2111) without being read in full.
 */
export const JSON_BODY_LIMIT = 600_000;

/** One widget unit of body: a request costs one unit per event, or per KiB when that is more. */
export const WIDGET_UNIT_BYTES = 1024;

/**
 * The smallest burst a widget bucket (token, address, project) may be
 * configured with: one full request must fit, i.e. a batch at the cap and
 * the arrival charge of a JSON body without a Content-Length.
 */
export const MIN_WIDGET_BURST = Math.max(
  MAX_BATCH_EVENTS,
  Math.ceil(JSON_BODY_LIMIT / WIDGET_UNIT_BYTES),
);
