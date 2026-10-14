import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static checks on the host-side files (#92): the parts that break silently.
// The scripts themselves were run against real containers, including a full
// restore onto new servers (see the PR).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("container log rotation (#92)", () => {
  const compose = read("docker-compose.yml");
  const services = compose
    .slice(compose.indexOf("\nservices:\n"), compose.indexOf("\nvolumes:\n"))
    .split("\n")
    .filter((l) => /^ {2}[a-z-]+:$/.test(l));

  it("rotates every service's log", () => {
    expect(services.length).toBeGreaterThanOrEqual(6);
    expect(compose.match(/^ {4}logging: \*logging$/gm)).toHaveLength(services.length);
  });

  it("bounds the size", () => {
    const anchor = compose.slice(
      compose.indexOf("x-logging: &logging"),
      compose.indexOf("\nservices:"),
    );
    expect(anchor).toMatch(/max-size: "\d+m"/);
    expect(anchor).toMatch(/max-file: "\d+"/);
  });
});

describe("backup scripts (#92)", () => {
  const pg = read("ops/backup/yavio-pg-backup.sh");
  const ch = read("ops/backup/yavio-clickhouse-backup.sh");
  const watchdog = read("ops/backup/yavio-backup-watchdog.sh");

  it("never pipes into grep -q under pipefail (it failed good dumps for two months)", () => {
    for (const script of [pg, ch]) {
      const code = script.replace(/^\s*#.*$/gm, "");
      expect(code).not.toMatch(/\|\s*grep -q/);
    }
  });

  it("backs up Postgres roles, which a dump does not carry", () => {
    expect(pg).toContain("pg_dumpall");
    expect(pg).toContain("--globals-only --no-role-passwords");
  });

  it("backs up ClickHouse's users and row policies, and checks they are in the archive", () => {
    for (const t of ["users", "roles", "row_policies", "settings_profiles", "quotas"]) {
      expect(ch).toContain(`TABLE system.${t}`);
    }
    expect(ch).toContain("*data/system/users/*");
    expect(ch).toContain("*data/system/row_policies/*");
  });

  it("keeps 14 by default — the 28-day rule (14 on the host + 14 in snapshots)", () => {
    expect(pg).toMatch(/KEEP=\$\{YAVIO_BACKUP_KEEP:-14\}/);
    expect(ch).toMatch(/KEEP=\$\{YAVIO_BACKUP_KEEP:-14\}/);
  });

  it("the watchdog looks for exactly the ok lines the scripts write", () => {
    expect(pg).toContain('ok $(basename "$OUT")');
    expect(pg).toContain('OUT="$DIR/yavio-control-plane-$TS.sql.gz"');
    expect(watchdog).toContain('" ok yavio-control-plane-${D}T"');
    expect(ch).toContain("ok clickhouse $NAME");
    expect(ch).toContain('NAME="yavio-clickhouse-$TS.zip"');
    expect(watchdog).toContain('" ok clickhouse yavio-clickhouse-${D}T"');
  });
});
