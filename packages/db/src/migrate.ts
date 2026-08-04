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

  // Migration 0003 creates the application role `yavio_api` with NO password,
  // so it fails closed: unlike 0001, which baked a literal 'yavio_dev' into
  // SQL that is published in a public repository, nothing here is guessable.
  // The password is applied from the environment instead, so it never appears
  // in a migration file or in the migration history.
  //
  // Skipped silently when unset: existing deployments predate this variable and
  // still connect as yavio_service, and their next migration run must not fail.
  const apiPassword = process.env.POSTGRES_API_PASSWORD;
  if (apiPassword) {
    const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'yavio_api'`;
    if (role) {
      // sql.unsafe is required because ALTER ROLE ... PASSWORD takes a literal,
      // not a bind parameter. The value comes from our own environment, never
      // from user input.
      await sql.unsafe(`ALTER ROLE yavio_api WITH PASSWORD '${apiPassword.replace(/'/g, "''")}'`);
      console.log("[migrate:postgres] Applied POSTGRES_API_PASSWORD to role yavio_api.");
    }
  }
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
