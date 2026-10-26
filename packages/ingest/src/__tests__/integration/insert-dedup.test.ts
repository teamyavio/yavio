import { randomUUID } from "node:crypto";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import { BatchWriter } from "../../lib/batch-writer.js";
import type { EnrichedEvent } from "../../lib/event-enricher.js";
import {
  disconnect,
  getClient,
  runMigrations,
  testClickHouseUrl,
} from "./helpers/clickhouse-setup.js";

// #90 item 4 against a real ClickHouse (the CI service, 26.8).

const CLICKHOUSE_URL = testClickHouseUrl();

function enriched(workspace: string): EnrichedEvent {
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  return {
    event_id: randomUUID(),
    event_type: "tool_call",
    trace_id: "trace-dedup",
    session_id: "session-dedup",
    timestamp: now,
    source: "server",
    workspace_id: workspace,
    project_id: "p-dedup",
  };
}

async function count(workspace: string, final: boolean): Promise<number> {
  const result = await getClient().query({
    query: `SELECT count() AS n FROM events ${final ? "FINAL" : ""} WHERE workspace_id = {ws:String}`,
    query_params: { ws: workspace },
    format: "JSONEachRow",
  });
  const [{ n }] = await result.json<{ n: string | number }>();
  return Number(n);
}

describe("insert deduplication (#90)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("events has a deduplication window", async () => {
    const result = await getClient().query({
      query: "SHOW CREATE TABLE events",
      format: "TabSeparatedRaw",
    });
    expect(await result.text()).toMatch(/non_replicated_deduplication_window = 1000/);
  });

  it("a batch the writer retries after a lost response is stored once, also without FINAL", async () => {
    const workspace = `ws-dedup-${randomUUID()}`;
    // As yavio_ingest, the user ingest inserts as: it must be allowed to set
    // the token. The insert reaches ClickHouse; the response is "lost" once.
    const ingestUser = new URL(CLICKHOUSE_URL);
    ingestUser.username = "yavio_ingest";
    ingestUser.password = process.env.CLICKHOUSE_INGEST_PASSWORD ?? "yavio_dev";
    const real = createClient({ url: ingestUser.toString() });
    let calls = 0;
    const flaky = {
      insert: async (params: Parameters<ClickHouseClient["insert"]>[0]) => {
        calls++;
        const result = await real.insert(params);
        if (calls === 1) throw new Error("socket hang up after the server stored the block");
        return result;
      },
    } as unknown as ClickHouseClient;

    // No background merges while counting: ReplacingMergeTree would collapse
    // a duplicate on merge and hide whether the retry was stored twice.
    await getClient().command({ query: "SYSTEM STOP MERGES events" });
    try {
      const writer = new BatchWriter({ clickhouse: flaky, flushSize: 100 });
      writer.enqueue([enriched(workspace), enriched(workspace)]);
      await writer.flush();
      await real.close();

      expect(calls).toBe(2);
      expect(await count(workspace, false)).toBe(2);
    } finally {
      await getClient().command({ query: "SYSTEM START MERGES events" });
    }
  });

  describe("an SDK resend of a request ingest already wrote", () => {
    let app: FastifyInstance;
    let writer: BatchWriter;

    afterEach(async () => {
      await app?.close();
    });

    it("is dropped by the deduplication window when it makes up a block of its own, and is one row with FINAL", async () => {
      writer = new BatchWriter({ clickhouse: getClient(), flushSize: 100 });
      app = await createApp({
        db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
        clickhouse: getClient(),
        apiKeyResolver: {
          resolve: async () => ({ projectId: "p-resend", workspaceId: "ws-resend-target" }),
          clearCache: () => {},
        } as unknown as ApiKeyResolver,
        jwtSecret: "s",
        batchWriter: writer,
        logger: false,
      });
      const workspace = "ws-resend-target";
      const before = await count(workspace, true);
      const body = {
        events: [
          {
            event_id: randomUUID(),
            event_type: "tool_call",
            trace_id: "trace-resend",
            session_id: "session-resend",
            timestamp: new Date().toISOString(),
            source: "server",
          },
        ],
      };
      const beforeRaw = await count(workspace, false);
      await getClient().command({ query: "SYSTEM STOP MERGES events" });
      try {
        for (let i = 0; i < 2; i++) {
          const r = await app.inject({
            method: "POST",
            url: "/v1/events",
            headers: { authorization: "Bearer yav_abc123def456abc123def456abc123de" },
            payload: body,
          });
          expect(r.statusCode).toBe(200);
          await writer.flush();
        }
        // The same rows, the same token (event_id and timestamp; ingested_at
        // is ClickHouse's since #148 review round 5): the second block is
        // dropped by the window — one row even without FINAL. A resend that
        // lands in a block with other rows is stored and collapsed by FINAL
        // (same sort key, event_id included), which the #85 job reads.
        expect((await count(workspace, false)) - beforeRaw).toBe(1);
      } finally {
        await getClient().command({ query: "SYSTEM START MERGES events" });
      }
      expect((await count(workspace, true)) - before).toBe(1);
    });
  });
});
