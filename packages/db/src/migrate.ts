import { ErrorCode, YavioError } from "@yavio/shared/errors";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new YavioError(ErrorCode.INFRA.REQUIRED_ENV_VAR_MISSING, "DATABASE_URL is not set.", 500, {
    variable: "DATABASE_URL",
  });
}

console.log("[migrate:postgres] Connecting to PostgreSQL…");

const sql = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(sql);

try {
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  console.log("[migrate:postgres] All migrations applied successfully.");
} catch (err) {
  throw new YavioError(
    ErrorCode.DB.PG_MIGRATION_FAILED,
    err instanceof Error ? err.message : "PostgreSQL migration failed",
    500,
    { cause: err },
  );
} finally {
  await sql.end();
}
