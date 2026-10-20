// Checks the packed SDK the way an app consumes it: compiled under the
// TypeScript settings apps use, and loaded with require(), import and a
// resolver that ignores `exports`.
//
// The SDK's own typecheck compiles its sources inside the monorepo, where
// @yavio/shared resolves and everything is ESM, so it cannot see what an app
// gets from npm. Every release up to 0.4.1 shipped declarations that imported
// the unpublished @yavio/shared and handed the ESM declarations to require();
// the unit tests were green throughout.
//
// Usage: node scripts/check-package.mjs [path/to/yavio-sdk-x.y.z.tgz]
// Given a tarball, it checks exactly that file. Without one it builds first
// (turbo, so packages/shared too) and packs this directory, so a green run
// never describes a stale dist/. The MCP SDK and React are installed at the
// versions this package is tested with (node_modules), so the compat workflow
// checks the MCP SDK floor and the latest release too.
//
// It installs packages from npm and runs them. Never run it where a publish
// credential is reachable: the release workflow runs it in a job without
// id-token permission.

import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, freemem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkDir, "../..");
const tsc = createRequire(join(sdkDir, "package.json")).resolve("typescript/bin/tsc");
const installedVersion = (name) =>
  JSON.parse(readFileSync(join(sdkDir, "node_modules", name, "package.json"), "utf8")).version;
const mcpVersion = installedVersion("@modelcontextprotocol/sdk");
const reactVersion = installedVersion("react");

// The settings apps actually use, with skipLibCheck off: on, an unresolvable
// import in our declarations is silently `any` (the @ts-expect-error lines
// below catch that too). Every error counts, in other packages' declarations
// as well, since an unresolved import there degrades types to `any` and could
// hide ours. The MCP SDK's declarations import express and the optional
// @cfworker/json-schema (1.24.0 does), so the app installs their types, as an
// app with skipLibCheck off has to.
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

// Each entry point must expose its API however it is loaded. "legacy" is an
// exports-unaware resolver (resolve@1, as in Jest before 28 or webpack 4):
// it finds the root through `main` and the subpath through react/package.json.
const RUNTIME = [
  { entry: "@yavio/sdk", exports: ["withYavio", "yavio", "platformValues"] },
  { entry: "@yavio/sdk/react", exports: ["useYavio", "extractWidgetConfig"] },
];

function loaders(entry, exports) {
  const id = JSON.stringify(entry);
  const check = `const missing = ${JSON.stringify(exports)}.filter((n) => typeof m[n] === "undefined");
if (missing.length > 0) throw new Error("missing exports: " + missing.join(", "));`;
  return {
    require: ["-e", `const m = require(${id});\n${check}`],
    import: ["--input-type=module", "-e", `const m = await import(${id});\n${check}`],
    legacy: [
      "-e",
      `const m = require(require("resolve").sync(${id}, { basedir: process.cwd() }));\n${check}`,
    ],
  };
}

// The checks are independent (one directory each), so they run side by side,
// as many at once as there are CPUs and free gigabytes: a type check with
// skipLibCheck off peaks at about 650 MB.
async function runAll(tasks) {
  const limit = Math.max(1, Math.min(availableParallelism(), Math.floor(freemem() / 1e9)));
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// Runs a command and returns its output on failure, or null on success. Every
// failure yields text: a process that could not start has no stdout/stderr.
async function failureOf(args, cwd) {
  try {
    await execFile(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (err) {
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    return output || err.message || `exited with ${err.code ?? err.signal}`;
  }
}

const work = mkdtempSync(join(tmpdir(), "yavio-check-package-"));
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    execFileSync(
      "pnpm",
      ["turbo", "run", "build", "--filter=@yavio/sdk...", "--output-logs=errors-only"],
      { cwd: repoRoot, stdio: "inherit" },
    );
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
      "@types/express@^5",
      "@cfworker/json-schema@^4.1.1",
      "resolve@^1.22.0",
    ],
    { cwd: work, stdio: ["ignore", "ignore", "inherit"] },
  );

  const checks = [];
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
    checks.push({
      name: c.name,
      run: () => failureOf([tsc, "-p", dir, "--pretty", "false"], work),
    });
  }
  for (const { entry, exports } of RUNTIME) {
    for (const [how, args] of Object.entries(loaders(entry, exports))) {
      checks.push({ name: `${how} ${entry}`, run: () => failureOf(args, work) });
    }
  }

  const failures = await runAll(checks.map((c) => c.run));
  const failed = [];
  checks.forEach(({ name }, i) => {
    if (failures[i] === null) {
      console.log(`ok    ${name}`);
    } else {
      console.log(`FAIL  ${name}\n${failures[i]}\n`);
      failed.push(name);
    }
  });
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
