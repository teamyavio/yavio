import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENTS_COLUMNS } from "../../lib/event-enricher.js";
import { jwtSign } from "../../lib/jwt.js";
import { WRITTEN_COLUMNS, columnProblems } from "../../lib/schema-guard.js";
import { disconnect, getClient, runMigrations } from "./helpers/clickhouse-setup.js";

// The ingest server as it runs in its container (src/server.ts, through
// tsx): its startup schema check and its shutdown on SIGTERM, against a
// real ClickHouse (the CI service, 26.8).

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "test";
const INGEST_PASSWORD = process.env.CLICKHOUSE_INGEST_PASSWORD ?? "yavio_dev";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://yavio_service:test@localhost:5432/yavio_test";
const JWT_SECRET = "startup-shutdown-jwt-secret";
const PROBE_DATABASE = "ingest_schema_probe";

/** A ClickHouse client as the user ingest connects as. */
function asIngest(database?: string): ClickHouseClient {
  const url = new URL(CLICKHOUSE_URL);
  url.username = "yavio_ingest";
  url.password = INGEST_PASSWORD;
  if (database) url.pathname = `/${database}`;
  return createClient({ url: url.toString() });
}

/** The URL the server is given: the `default` user's, as in docker-compose.yml. */
function serverClickHouseUrl(database?: string): string {
  const url = new URL(CLICKHOUSE_URL);
  url.username = "default";
  url.password = CLICKHOUSE_PASSWORD;
  if (database) url.pathname = `/${database}`;
  return url.toString();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

interface Server {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startServer(port: number, env: Record<string, string>): Server {
  // Node itself, with tsx's loader: signals reach the server's own process,
  // as they do in its container.
  const packageDir = join(__dirname, "..", "..", "..");
  const child = spawn(process.execPath, ["--import", "tsx", join(packageDir, "src", "server.ts")], {
    cwd: packageDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      CLICKHOUSE_URL: serverClickHouseUrl(),
      CLICKHOUSE_INGEST_PASSWORD: INGEST_PASSWORD,
      CLICKHOUSE_ROLLUP_PASSWORD: "",
      API_KEY_HASH_SECRET: "startup-shutdown-hash-secret",
      JWT_SECRET,
      INGEST_SKIP_SCHEMA_CHECK: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const server = { child, port, output: () => output, exited };
  started.push(server);
  return server;
}

/** Until /health answers, or the server exits. */
async function ready(server: Server, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  server.exited.then(() => {
    exited = true;
  });
  while (Date.now() < deadline && !exited) {
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/health`);
      if (r.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const started: Server[] = [];

/** How the server exited, or null when it was still running after `timeoutMs` (then killed). */
async function exitWithin(
  server: Server,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const result = await Promise.race([server.exited, timeout]);
  if (result === null) server.child.kill("SIGKILL");
  return result;
}

describe("ingest startup and shutdown", () => {
  beforeAll(async () => {
    await runMigrations();
    // A database whose tables lack a column ingest writes and hold another
    // type for one: what ingest sees when a migration was not applied.
    const ch = getClient();
    await ch.command({ query: `DROP DATABASE IF EXISTS ${PROBE_DATABASE}` });
    await ch.command({ query: `CREATE DATABASE ${PROBE_DATABASE}` });
    await ch.command({ query: `CREATE TABLE ${PROBE_DATABASE}.events AS default.events` });
    await ch.command({
      query: `CREATE TABLE ${PROBE_DATABASE}.tool_registry AS default.tool_registry`,
    });
    await ch.command({ query: `ALTER TABLE ${PROBE_DATABASE}.events DROP COLUMN session_source` });
    await ch.command({
      query: `ALTER TABLE ${PROBE_DATABASE}.events MODIFY COLUMN tokens_in Nullable(UInt64)`,
    });
    await ch.command({
      query: `GRANT SELECT, INSERT ON ${PROBE_DATABASE}.* TO yavio_ingest`,
    });
  }, 60_000);

  afterAll(async () => {
    for (const server of started) server.child.kill("SIGKILL");
    await getClient().command({ query: `DROP DATABASE IF EXISTS ${PROBE_DATABASE}` });
    await disconnect();
  });

  it("finds every column ingest writes, with its type, after all migrations — as the ingest user", async () => {
    const ch = asIngest();
    try {
      expect(await columnProblems(ch)).toEqual([]);
    } finally {
      await ch.close();
    }
    // The numeric columns, as the schema bounds them (numeric-bounds.test.ts).
    expect(
      Object.fromEntries(
        Object.entries(EVENTS_COLUMNS).filter(([, type]) => /Int|Float/.test(type)),
      ),
    ).toEqual({
      latency_ms: "Nullable(Float64)",
      is_retry: "UInt8",
      tokens_in: "Nullable(UInt32)",
      tokens_out: "Nullable(UInt32)",
      conversion_value: "Nullable(Float64)",
      viewport_width: "Nullable(UInt16)",
      viewport_height: "Nullable(UInt16)",
      connection_duration_ms: "Nullable(Float64)",
      scroll_depth_pct: "Nullable(Float64)",
      click_count: "Nullable(UInt32)",
      visible_duration_ms: "Nullable(Float64)",
      device_touch: "Nullable(UInt8)",
      device_pixel_ratio: "Nullable(Float32)",
      load_time_ms: "Nullable(Float64)",
      step_sequence: "Nullable(UInt32)",
    });
    expect(Object.keys(WRITTEN_COLUMNS)).toEqual(["events", "tool_registry"]);
  });

  it("reports a missing column and another type", async () => {
    const ch = asIngest(PROBE_DATABASE);
    try {
      expect(await columnProblems(ch)).toEqual([
        {
          table: "events",
          column: "tokens_in",
          expected: "Nullable(UInt32)",
          actual: "Nullable(UInt64)",
        },
        {
          table: "events",
          column: "session_source",
          expected: "LowCardinality(Nullable(String))",
          actual: null,
        },
      ]);
    } finally {
      await ch.close();
    }
  });

  it("exits at startup, naming the columns, when ClickHouse lacks one or holds another type", async () => {
    const server = startServer(await freePort(), {
      CLICKHOUSE_URL: serverClickHouseUrl(PROBE_DATABASE),
    });
    const exit = await exitWithin(server, 30_000);
    expect(exit?.code).toBe(1);
    expect(server.output()).toContain("events.session_source is missing");
    expect(server.output()).toContain(
      "events.tokens_in is Nullable(UInt64), ingest writes Nullable(UInt32)",
    );
  }, 60_000);

  it("starts anyway with INGEST_SKIP_SCHEMA_CHECK=1, saying so", async () => {
    const server = startServer(await freePort(), {
      CLICKHOUSE_URL: serverClickHouseUrl(PROBE_DATABASE),
      INGEST_SKIP_SCHEMA_CHECK: "1",
    });
    try {
      expect(await ready(server)).toBe(true);
      expect(server.output()).toContain("ClickHouse schema check skipped");
    } finally {
      server.child.kill("SIGTERM");
      await exitWithin(server, 25_000);
    }
  }, 60_000);

  it("writes the buffered events on SIGTERM and exits 0", async () => {
    const server = startServer(await freePort(), {});
    expect(await ready(server)).toBe(true);

    const project = `p-sigterm-${randomUUID()}`;
    const traceId = `trace-sigterm-${randomUUID().slice(0, 8)}`;
    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: project,
        wid: "ws-sigterm",
        tid: traceId,
        sid: "ses-sigterm",
        iat: now,
        exp: now + 900,
      },
      JWT_SECRET,
    );
    const ids = Array.from({ length: 20 }, () => randomUUID());
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        events: ids.map((event_id) => ({
          event_id,
          event_type: "widget_click",
          trace_id: traceId,
          session_id: "ses-sigterm",
          timestamp: new Date().toISOString(),
          source: "widget",
          click_count: 1,
        })),
      }),
    });
    expect(response.status).toBe(200);
    server.child.kill("SIGTERM");

    const exit = await exitWithin(server, 25_000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(server.output()).toContain("Shutting down");
    const result = await getClient().query({
      query: "SELECT count() AS n FROM events WHERE project_id = {p:String}",
      query_params: { p: project },
      format: "JSONEachRow",
    });
    const [{ n }] = await result.json<{ n: string | number }>();
    expect(Number(n)).toBe(20);
  }, 60_000);
});
