import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static checks on the ClickHouse version pin (#95) and the system-log config
// (#92). No database needed.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
// A tag starts with a digit; this skips the grep pattern in ci.yml itself.
const IMAGE = /clickhouse\/clickhouse-server:(\d[^\s"']*)/g;

function tags(rel: string): string[] {
  return [...read(rel).matchAll(IMAGE)].map((m) => m[1]);
}

describe("ClickHouse image pin (#95)", () => {
  it("pins one exact four-part version in both compose files", () => {
    const all = [...tags("docker-compose.yml"), ...tags("docker-compose.test.yml")];
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(1);
    // A moving tag like 26.8 would change the server under a deployment
    // without a PR, and an upgrade cannot be rolled back.
    expect(all[0]).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("CI takes the tag from docker-compose.test.yml instead of hard-coding one", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(tags(".github/workflows/ci.yml")).toEqual([]);
    expect(ci).toContain("image: ${{ needs.detect.outputs.clickhouse_image }}");
  });

  it("Dependabot watches the compose files for ClickHouse patch releases", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot).toContain('package-ecosystem: "docker-compose"');
    expect(dependabot).toContain('dependency-name: "clickhouse/clickhouse-server"');
  });
});

describe("system-log config (#92)", () => {
  const xml = read("packages/db/clickhouse/config.d/system-logs.xml").replace(
    /<!--[\s\S]*?-->/g,
    "",
  );

  it("never adds a section for a log the stock config disables — a section enables it", () => {
    expect(xml).not.toMatch(/<session_log[\s>]/);
    expect(xml).not.toMatch(/<zookeeper_log[\s>]/);
  });

  it("does not combine <ttl> with <engine>, which ClickHouse rejects", () => {
    expect(xml).not.toMatch(/<engine>/);
  });

  it("is mounted by both compose files", () => {
    for (const rel of ["docker-compose.yml", "docker-compose.test.yml"]) {
      expect(read(rel)).toContain(
        "./packages/db/clickhouse/config.d/system-logs.xml:/etc/clickhouse-server/config.d/yavio-system-logs.xml:ro",
      );
    }
  });
});
