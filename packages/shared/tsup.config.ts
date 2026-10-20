import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/error-codes.ts",
    "src/errors.ts",
    "src/events.ts",
    "src/validation.ts",
    "src/platform.ts",
    "src/geo.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});
