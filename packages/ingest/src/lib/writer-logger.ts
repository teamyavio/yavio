import type { FastifyBaseLogger } from "fastify";
import type { BatchWriterLogger } from "./batch-writer.js";

/**
 * The batch writers' warnings (rows ClickHouse refused, rows retried behind
 * newer events, events dropped at shutdown) in the app's log, their details
 * as fields: pino takes the object first and the message second, and drops
 * arguments after the message that it has no placeholder for.
 *
 * The writers exist before the app — createApp takes them — so the app's
 * logger is attached once it does (server.ts). Until then nothing has been
 * buffered, so there is nothing to report.
 */
export function deferredWriterLogger(): {
  logger: BatchWriterLogger;
  attach(log: FastifyBaseLogger): void;
} {
  let log: FastifyBaseLogger | undefined;
  return {
    logger: {
      warn: (msg, ...args) => {
        const [detail] = args;
        if (detail instanceof Error) log?.warn({ err: detail }, msg);
        else if (detail !== null && typeof detail === "object") log?.warn(detail, msg);
        else log?.warn(msg);
      },
    },
    attach: (target) => {
      log = target;
    },
  };
}
