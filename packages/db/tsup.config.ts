import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/schema.ts",
    "src/client.ts",
    "src/rls.ts",
    "src/clickhouse-client.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: ["drizzle-orm", "postgres", "@clickhouse/client"],
});
