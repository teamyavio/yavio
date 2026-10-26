import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { BatchWriter } from "../lib/batch-writer.js";
import { deferredWriterLogger } from "../lib/writer-logger.js";

function appLogging(lines: string[]) {
  return Fastify({ logger: { stream: { write: (line: string) => lines.push(line) } } });
}

describe("deferredWriterLogger", () => {
  it("writes a writer's warnings to the app's log once attached, details as fields", async () => {
    const lines: string[] = [];
    const app = appLogging(lines);
    const { logger, attach } = deferredWriterLogger();
    logger.warn("before the app exists");
    attach(app.log);
    logger.warn("Dropped 1 events", { dropped: 1, event_ids: ["e-1"], project_ids: ["p-1"] });
    logger.warn("Background flush failed", new Error("boom"));
    logger.warn("Shutdown timeout: 2 events dropped");
    await app.close();

    const logged = lines.map((line) => JSON.parse(line));
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({
      level: 40,
      msg: "Dropped 1 events",
      dropped: 1,
      event_ids: ["e-1"],
      project_ids: ["p-1"],
    });
    expect(logged[1]).toMatchObject({ msg: "Background flush failed", err: { message: "boom" } });
    expect(logged[2]).toMatchObject({ level: 40, msg: "Shutdown timeout: 2 events dropped" });
  });

  it("carries a batch writer's warning about a refused row into the log", async () => {
    const lines: string[] = [];
    const app = appLogging(lines);
    const { logger, attach } = deferredWriterLogger();
    attach(app.log);
    const clickhouse = {
      insert: async ({ values }: { values: Array<{ event_id: string }> }) => {
        const at = values.findIndex((v) => v.event_id === "evt-bad");
        if (at >= 0) {
          throw new ClickHouseError({
            message: `Unsigned type must not contain '-' symbol: (at row ${at + 1})`,
            code: "72",
            type: "CANNOT_PARSE_NUMBER",
          });
        }
      },
    } as unknown as ClickHouseClient;
    const writer = new BatchWriter({ clickhouse, logger });
    const event = (id: string) => ({
      event_id: id,
      event_type: "tool_call",
      trace_id: "t",
      session_id: "s",
      timestamp: "2026-10-26 12:00:00.000",
      source: "server",
      workspace_id: "w",
      project_id: "p-1",
    });
    writer.enqueue([event("evt-ok"), event("evt-bad")]);
    await writer.flush();
    await app.close();

    const [line] = lines.map((l) => JSON.parse(l));
    expect(line).toMatchObject({
      level: 40,
      dropped: 1,
      event_ids: ["evt-bad"],
      project_ids: ["p-1"],
      errors: ["CANNOT_PARSE_NUMBER"],
    });
  });
});
