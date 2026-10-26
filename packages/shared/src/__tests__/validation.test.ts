import { describe, expect, it } from "vitest";
import {
  ApiKeyFormat,
  ApiKeyPrefix,
  CurrencyCode,
  IsoDatetime,
  PaginationParams,
  ProjectSlug,
  SessionId,
  TimeRange,
  Uuid,
  WorkspaceRole,
  WorkspaceSlug,
} from "../validation.js";

describe("Uuid", () => {
  it("accepts a valid UUID v4", () => {
    expect(Uuid.parse("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rejects non-UUID strings", () => {
    expect(() => Uuid.parse("not-a-uuid")).toThrow();
    expect(() => Uuid.parse("")).toThrow();
  });

  it("accepts UUID-shaped ids of any version and variant, as zod 3's .uuid() did", () => {
    expect(Uuid.safeParse("11111111-1111-1111-1111-111111111111").success).toBe(true);
    expect(Uuid.safeParse("00000000-0000-0000-0000-000000000001").success).toBe(true);
  });
});

describe("WorkspaceSlug", () => {
  it("accepts valid slugs", () => {
    expect(WorkspaceSlug.parse("my-workspace")).toBe("my-workspace");
    expect(WorkspaceSlug.parse("abc")).toBe("abc");
    expect(WorkspaceSlug.parse("a0b")).toBe("a0b");
  });

  it("rejects slugs shorter than 3 chars", () => {
    expect(() => WorkspaceSlug.parse("ab")).toThrow();
  });

  it("rejects slugs longer than 48 chars", () => {
    expect(() => WorkspaceSlug.parse("a".repeat(49))).toThrow();
  });

  it("rejects slugs starting with a hyphen", () => {
    expect(() => WorkspaceSlug.parse("-abc")).toThrow();
  });

  it("rejects slugs ending with a hyphen", () => {
    expect(() => WorkspaceSlug.parse("abc-")).toThrow();
  });

  it("rejects uppercase letters", () => {
    expect(() => WorkspaceSlug.parse("MyWorkspace")).toThrow();
  });
});

describe("ProjectSlug", () => {
  it("accepts valid slugs", () => {
    expect(ProjectSlug.parse("my-project")).toBe("my-project");
    expect(ProjectSlug.parse("ab")).toBe("ab");
  });

  it("rejects slugs shorter than 2 chars", () => {
    expect(() => ProjectSlug.parse("a")).toThrow();
  });

  it("rejects slugs longer than 48 chars", () => {
    expect(() => ProjectSlug.parse("a".repeat(49))).toThrow();
  });

  it("rejects slugs with invalid characters", () => {
    expect(() => ProjectSlug.parse("my_project")).toThrow();
    expect(() => ProjectSlug.parse("my project")).toThrow();
  });
});

describe("ApiKeyFormat", () => {
  it("accepts a valid API key", () => {
    const key = `yav_${"a".repeat(32)}`;
    expect(ApiKeyFormat.parse(key)).toBe(key);
  });

  it("accepts keys longer than 32 hex chars", () => {
    const key = `yav_${"f".repeat(64)}`;
    expect(ApiKeyFormat.parse(key)).toBe(key);
  });

  it("rejects keys without yav_ prefix", () => {
    expect(() => ApiKeyFormat.parse(`key_${"a".repeat(32)}`)).toThrow();
  });

  it("rejects keys with non-hex characters", () => {
    expect(() => ApiKeyFormat.parse(`yav_${"g".repeat(32)}`)).toThrow();
  });

  it("rejects keys shorter than 32 hex chars", () => {
    expect(() => ApiKeyFormat.parse("yav_abc")).toThrow();
  });
});

describe("ApiKeyPrefix", () => {
  it("accepts a valid prefix", () => {
    expect(ApiKeyPrefix.parse("yav_abcd1234")).toBe("yav_abcd1234");
  });

  it("rejects prefixes with wrong length", () => {
    expect(() => ApiKeyPrefix.parse("yav_abc")).toThrow();
    expect(() => ApiKeyPrefix.parse("yav_abcdefghi")).toThrow();
  });

  it("rejects prefixes without yav_ prefix", () => {
    expect(() => ApiKeyPrefix.parse("key_abcd1234")).toThrow();
  });
});

describe("SessionId", () => {
  it("accepts a valid session ID", () => {
    expect(SessionId.parse("ses_abc123")).toBe("ses_abc123");
  });

  it("rejects IDs without ses_ prefix", () => {
    expect(() => SessionId.parse("tr_abc123")).toThrow();
  });

  it("rejects IDs with special characters", () => {
    expect(() => SessionId.parse("ses_abc-123")).toThrow();
  });
});

describe("WorkspaceRole", () => {
  it("accepts all valid roles", () => {
    expect(WorkspaceRole.parse("owner")).toBe("owner");
    expect(WorkspaceRole.parse("admin")).toBe("admin");
    expect(WorkspaceRole.parse("member")).toBe("member");
    expect(WorkspaceRole.parse("viewer")).toBe("viewer");
  });

  it("rejects invalid roles", () => {
    expect(() => WorkspaceRole.parse("superadmin")).toThrow();
  });
});

describe("PaginationParams", () => {
  it("uses defaults when no values provided", () => {
    const result = PaginationParams.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it("accepts valid values", () => {
    const result = PaginationParams.parse({ limit: 50, offset: 10 });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(10);
  });

  it("coerces string values", () => {
    const result = PaginationParams.parse({ limit: "30", offset: "5" });
    expect(result.limit).toBe(30);
    expect(result.offset).toBe(5);
  });

  it("rejects limit below 1", () => {
    expect(() => PaginationParams.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit above 100", () => {
    expect(() => PaginationParams.parse({ limit: 101 })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => PaginationParams.parse({ offset: -1 })).toThrow();
  });
});

describe("TimeRange", () => {
  it("accepts valid ISO datetime strings", () => {
    const result = TimeRange.parse({
      from: "2025-01-01T00:00:00Z",
      to: "2025-01-31T23:59:59Z",
    });
    expect(result.from).toBe("2025-01-01T00:00:00Z");
    expect(result.to).toBe("2025-01-31T23:59:59Z");
  });

  it("rejects invalid datetime strings", () => {
    expect(() => TimeRange.parse({ from: "2025-01-01", to: "2025-01-31" })).toThrow();
    expect(() => TimeRange.parse({ from: "not-a-date", to: "2025-01-31T00:00:00Z" })).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() => TimeRange.parse({ from: "2025-01-01T00:00:00Z" })).toThrow();
    expect(() => TimeRange.parse({ to: "2025-01-31T00:00:00Z" })).toThrow();
  });
});

describe("IsoDatetime", () => {
  it("accepts UTC datetimes with or without seconds, and any fraction", () => {
    for (const v of [
      "2026-10-26T10:00Z",
      "2026-10-26T10:00:00Z",
      "2026-10-26T10:00:00.123Z",
      "2026-10-26T10:00:00.123456789Z",
    ]) {
      expect(IsoDatetime.safeParse(v).success).toBe(true);
    }
  });

  it("rejects offsets, a missing zone, and anything short of minutes", () => {
    for (const v of [
      "2026-10-26T10:00:00+02:00",
      "2026-10-26T10:00:00",
      "2026-10-26",
      "2026-10-26T10Z",
      "2026-02-30T10:00:00Z",
    ]) {
      expect(IsoDatetime.safeParse(v).success).toBe(false);
    }
  });
});

describe("CurrencyCode", () => {
  it("accepts a 3-letter code and uppercases it", () => {
    expect(CurrencyCode.parse("usd")).toBe("USD");
    expect(CurrencyCode.parse("EUR")).toBe("EUR");
  });

  it("rejects codes not exactly 3 chars", () => {
    expect(() => CurrencyCode.parse("US")).toThrow();
    expect(() => CurrencyCode.parse("EURO")).toThrow();
  });
});
