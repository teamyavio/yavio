import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/server/index.ts",
    react: "src/react/index.ts",
  },
  format: ["esm", "cjs"],
  // @yavio/shared is not published, so its types have to end up in our
  // declaration files just like its code ends up in our bundle (noExternal).
  // Left to package resolution, `@yavio/shared/platform` stays an import no
  // consumer can satisfy (tsup's `dts.resolve` does not follow subpath
  // exports). Mapped to its source, the declaration bundler inlines it;
  // rootDir has to cover that source.
  dts: {
    compilerOptions: {
      rootDir: "..",
      paths: { "@yavio/shared/*": ["../shared/src/*"] },
    },
  },
  clean: true,
  noExternal: ["@yavio/shared"],
  external: ["@modelcontextprotocol/sdk", "react", "react-dom"],
});
