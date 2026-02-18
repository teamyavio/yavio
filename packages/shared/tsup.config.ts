import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/error-codes.ts",
    "src/errors.ts",
    "src/events.ts",
    "src/validation.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});
