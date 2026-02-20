import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/index.ts" },
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  outExtension: () => ({ js: ".mjs" }),
});
