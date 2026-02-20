import { getClickHouseClient } from "@/lib/clickhouse";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, "ok" | "error"> = {};

  try {
    const db = getDb();
    await db.execute(/* sql */ "SELECT 1");
    checks.postgres = "ok";
  } catch {
    checks.postgres = "error";
  }

  try {
    const ch = getClickHouseClient();
    await ch.query({ query: "SELECT 1" });
    checks.clickhouse = "ok";
  } catch {
    checks.clickhouse = "error";
  }

  const healthy = checks.postgres === "ok" && checks.clickhouse === "ok";

  return NextResponse.json(
    { status: healthy ? "healthy" : "degraded", checks },
    { status: healthy ? 200 : 503 },
  );
}
