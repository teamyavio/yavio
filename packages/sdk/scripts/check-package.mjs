// Checks the packed SDK the way an app consumes it: compiled under the
// TypeScript settings apps use, and loaded with require() and import.
//
// The SDK's own typecheck compiles its sources inside the monorepo, where
// @yavio/shared resolves and everything is ESM, so it cannot see what an app
// gets from npm. Every release up to 0.4.1 shipped declarations that imported
// the unpublished @yavio/shared and handed the ESM declarations to require();
// the unit tests were green throughout.
//
// Usage: node scripts/check-package.mjs [path/to/yavio-sdk-x.y.z.tgz]
// Without an argument it packs this directory, so build first. The MCP SDK and
// React are installed at the versions this package is tested with
// (node_modules), so the compat workflow checks the MCP SDK floor and the
// latest release too.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(join(sdkDir, "package.json")).resolve("typescript/bin/tsc");
const installedVersion = (name) =>
  JSON.parse(readFileSync(join(sdkDir, "node_modules", name, "package.json"), "utf8")).version;
const mcpVersion = installedVersion("@modelcontextprotocol/sdk");
const reactVersion = installedVersion("react");

// The settings apps actually use, with skipLibCheck off: on, an unresolvable
// import in our declarations is silently `any` (the @ts-expect-error lines
// below catch that too). Only errors in our declarations and the app's own
// files count; other packages' declarations are not ours to fix (MCP SDK
// 1.24.0's need @types/express and the optional @cfworker/json-schema).
const CASES = [
  { name: "esm-nodenext", type: "module", module: "nodenext", moduleResolution: "nodenext" },
  { name: "esm-bundler", type: "module", module: "esnext", moduleResolution: "bundler" },
  { name: "cjs-nodenext", type: "commonjs", module: "nodenext", moduleResolution: "nodenext" },
  { name: "cjs-node10", type: "commonjs", module: "commonjs", moduleResolution: "node10" },
];

const SOURCES = {
  "server.ts": `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Platform, platformValues, withYavio } from "@yavio/sdk";

// Fails when require() gets the ESM declarations: the app's McpServer is then
// the CommonJS class and withYavio() expects the ESM one.
export const server = withYavio(new McpServer({ name: "consumer", version: "1.0.0" }));

export const first: Platform = platformValues[0];
// @ts-expect-error unused, and so an error, if Platform has become any
export const bogus: Platform = "not-a-platform";
`,
  "widget.ts": `import { type YavioWidget, useYavio } from "@yavio/sdk/react";

export const hook: (config?: Record<string, unknown>) => YavioWidget = useYavio;
// @ts-expect-error unused, and so an error, if YavioWidget has become any
export const bogus: YavioWidget = 1;
`,
};

// Each entry point, loaded both ways, must expose its API.
const RUNTIME = [
  { entry: "@yavio/sdk", exports: ["withYavio", "yavio", "platformValues"] },
  { entry: "@yavio/sdk/react", exports: ["useYavio", "extractWidgetConfig"] },
];

// Runs tsc and splits its diagnostics by where they are: in another package's
// declarations, or anywhere else (ours, the app's files, the config).
function typecheck(dir) {
  let output = "";
  try {
    execFileSync(process.execPath, [tsc, "-p", dir, "--pretty", "false"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    output = `${err.stdout}${err.stderr}`;
    // Without a diagnostic to show, a failed run must not read as a pass.
    if (output.trim() === "") output = `tsc exited with ${err.status ?? err.signal}`;
  }
  // A diagnostic starts at column 0; indented lines continue the previous one.
  const diagnostics = output.split(/\n(?=\S)/).filter((d) => d.trim() !== "");
  const isForeign = (d) => {
    const file = d.split("(")[0];
    return file.includes("/node_modules/") && !file.includes("/node_modules/@yavio/sdk/");
  };
  return {
    ours: diagnostics.filter((d) => !isForeign(d)),
    foreign: diagnostics.filter(isForeign).length,
  };
}

const work = mkdtempSync(join(tmpdir(), "yavio-check-package-"));
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
      cwd: sdkDir,
      encoding: "utf8",
    });
    tarball = join(work, JSON.parse(packed)[0].filename);
  }
  console.log(`package: ${tarball}`);
  console.log(`@modelcontextprotocol/sdk ${mcpVersion}, react ${reactVersion}`);

  // Outside the repository, so nothing can resolve to the workspace sources.
  writeFileSync(join(work, "package.json"), '{ "name": "consumer", "private": true }\n');
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--no-package-lock",
      tarball,
      `@modelcontextprotocol/sdk@${mcpVersion}`,
      `react@${reactVersion}`,
    ],
    { cwd: work, stdio: ["ignore", "ignore", "inherit"] },
  );

  const failed = [];
  for (const c of CASES) {
    const dir = join(work, c.name);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: c.type })}\n`);
    for (const [file, source] of Object.entries(SOURCES)) writeFileSync(join(dir, file), source);
    const compilerOptions = {
      target: "es2022",
      module: c.module,
      moduleResolution: c.moduleResolution,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
    };
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions, files: Object.keys(SOURCES) }, null, 2),
    );
    const { ours, foreign } = typecheck(dir);
    const note =
      foreign > 0 ? ` (${foreign} error(s) in other packages' declarations ignored)` : "";
    if (ours.length === 0) {
      console.log(`ok    ${c.name}${note}`);
    } else {
      console.log(`FAIL  ${c.name}${note}\n${ours.join("\n")}\n`);
      failed.push(c.name);
    }
  }
  for (const { entry, exports } of RUNTIME) {
    const check = `const missing = ${JSON.stringify(exports)}.filter((n) => typeof m[n] === "undefined");
if (missing.length > 0) throw new Error("missing exports: " + missing.join(", "));`;
    const loaders = {
      require: ["-e", `const m = require(${JSON.stringify(entry)});\n${check}`],
      import: [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(entry)});\n${check}`,
      ],
    };
    for (const [how, args] of Object.entries(loaders)) {
      const name = `${how} ${entry}`;
      try {
        execFileSync(process.execPath, args, { cwd: work, encoding: "utf8", stdio: "pipe" });
        console.log(`ok    ${name}`);
      } catch (err) {
        console.log(`FAIL  ${name}\n${err.stderr}`);
        failed.push(name);
      }
    }
  }

  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
