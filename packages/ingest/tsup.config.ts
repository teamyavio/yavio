import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: [
    "fastify",
    "@fastify/cors",
    "fastify-plugin",
    "drizzle-orm",
    "postgres",
    "@clickhouse/client",
  ],
});
