import type { FastifyBaseLogger } from "fastify";
import type { BatchWriterLogger } from "./batch-writer.js";

/**
 * The batch writers' warnings and errors (rows ClickHouse refused, rows set
 * apart, events dropped at shutdown) in the app's log, their details as
 * fields: pino takes the object first and the message second, and drops
 * arguments after the message that it has no placeholder for.
 *
 * The writers exist before the app — createApp takes them — so the app's
 * logger is attached once it does (server.ts). Until then nothing has been
 * buffered, so there is nothing to report.
 */
export function deferredWriterLogger(): {
  logger: Required<BatchWriterLogger>;
  attach(log: FastifyBaseLogger): void;
} {
  let log: FastifyBaseLogger | undefined;
  const at =
    (level: "warn" | "error") =>
    (msg: string, ...args: unknown[]): void => {
      if (!log) return;
      const [detail] = args;
      if (detail instanceof Error) log[level]({ err: detail }, msg);
      else if (detail !== null && typeof detail === "object") log[level](detail, msg);
      else log[level](msg);
    };
  return {
    logger: { warn: at("warn"), error: at("error") },
    attach: (target) => {
      log = target;
    },
  };
}
