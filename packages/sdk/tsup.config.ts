import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/server/index.ts",
    react: "src/react/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  noExternal: ["@yavio/shared"],
  external: ["@modelcontextprotocol/sdk", "react", "react-dom"],
});
