import { describe, expect, it } from "vitest";
import {
  splitStatements,
  stripComments,
  versionFromFilename,
} from "../migrate-clickhouse-helpers.js";

describe("versionFromFilename", () => {
  it("extracts version from standard filename", () => {
    expect(versionFromFilename("0002_events_table.sql")).toBe("0002");
  });

  it("extracts version from single-digit prefix", () => {
    expect(versionFromFilename("1_init.sql")).toBe("1");
  });

  it("extracts version from long prefix", () => {
    expect(versionFromFilename("00010_feature.sql")).toBe("00010");
  });

  it("throws on filename without numeric prefix", () => {
    expect(() => versionFromFilename("no_version.sql")).toThrow("Invalid migration filename");
  });
});

describe("stripComments", () => {
  it("removes full-line comments", () => {
    expect(stripComments("-- comment\nSELECT 1")).toBe("SELECT 1");
  });

  it("removes inline trailing comments", () => {
    expect(stripComments("SELECT 1 -- inline")).toBe("SELECT 1");
  });

  it("preserves non-comment lines", () => {
    expect(stripComments("SELECT 1\nFROM t")).toBe("SELECT 1\nFROM t");
  });

  it("trims result", () => {
    expect(stripComments("  SELECT 1  \n")).toBe("SELECT 1");
  });

  it("handles empty input", () => {
    expect(stripComments("")).toBe("");
  });

  it("handles all-comments input", () => {
    expect(stripComments("-- only comment\n-- another")).toBe("");
  });
});

describe("splitStatements", () => {
  it("splits on semicolons", () => {
    expect(splitStatements("CREATE TABLE t1 (id INT);\nCREATE TABLE t2 (id INT);")).toEqual([
      "CREATE TABLE t1 (id INT)",
      "CREATE TABLE t2 (id INT)",
    ]);
  });

  it("strips comments before splitting", () => {
    expect(splitStatements("-- header\nSELECT 1;\n-- between\nSELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("filters empty statements", () => {
    expect(splitStatements("SELECT 1;;;")).toEqual(["SELECT 1"]);
  });

  it("handles trailing semicolon", () => {
    expect(splitStatements("SELECT 1;")).toEqual(["SELECT 1"]);
  });

  it("returns empty array for empty input", () => {
    expect(splitStatements("")).toEqual([]);
  });

  it("returns empty array for comments-only input", () => {
    expect(splitStatements("-- just a comment")).toEqual([]);
  });
});
