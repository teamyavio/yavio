/**
 * The README's serverless recipes (#171) are the code `tsc` checks: the
 * fenced block after each `<!-- recipe:NAME -->` marker equals the text
 * between `// recipe:start` and `// recipe:end` in `fixtures/recipes/NAME.ts`,
 * less the lines marked "fixture only" (the imports a README block leaves to
 * the one before it) and with `@yavio/sdk` for the fixture's source path —
 * the shutdown recipe's identity test (#148) for these.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = join(here, "..", "..", "..");
const RECIPES = [
  "shared",
  "lambda-request",
  "lambda",
  "lambda-streaming",
  "vercel",
  "next-after",
  "workers",
  "netlify",
];

const readme = readFileSync(join(SDK_DIR, "README.md"), "utf8");

describe("the README's serverless recipes (#171)", () => {
  it("has a marker for every fixture and a fixture for every marker", () => {
    const markers = [...readme.matchAll(/<!-- recipe:([a-z-]+) -->/g)].map((m) => m[1]);
    expect(markers).toEqual(RECIPES);
  });

  it.each(RECIPES)("recipe:%s is the fixture's code", (name) => {
    const marker = readme.indexOf(`<!-- recipe:${name} -->`);
    expect(marker).toBeGreaterThan(0);
    const fence = /```typescript\n([\s\S]*?)```/.exec(readme.slice(marker));
    expect(fence).not.toBeNull();

    const fixture = readFileSync(join(here, "fixtures", "recipes", `${name}.ts`), "utf8");
    const from = fixture.indexOf("// recipe:start\n");
    const to = fixture.indexOf("// recipe:end");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const block = fixture
      .slice(from + "// recipe:start\n".length, to)
      .split("\n")
      .filter((line) => !line.endsWith("// fixture only"))
      .join("\n")
      .replace('"../../../../server/index.js"', '"@yavio/sdk"');

    expect(block.trim()).toBe((fence as RegExpExecArray)[1]?.trim());
  });
});
