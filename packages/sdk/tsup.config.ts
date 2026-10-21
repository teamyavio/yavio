import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/server/index.ts",
    react: "src/react/index.ts",
  },
  format: ["esm", "cjs"],
  // @yavio/shared is not published: its code is bundled (noExternal) and its
  // types are inlined into our declarations. tsconfig.build.json maps it to
  // its source for both, so the bundle and the declarations come from the
  // same files and neither depends on a fresh packages/shared/dist. Left to
  // package resolution, `@yavio/shared/platform` stayed an import in
  // index.d.ts that no consumer can satisfy (tsup's `dts.resolve` does not
  // follow subpath exports).
  tsconfig: "tsconfig.build.json",
  dts: true,
  clean: true,
  noExternal: ["@yavio/shared"],
  // Neither MCP package is imported at runtime (the server is typed by shape,
  // core/types.ts McpServerLike); listed so a stray import can never be bundled.
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/server", "react", "react-dom"],
});
