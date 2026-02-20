import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: ["@modelcontextprotocol/sdk"],
});
