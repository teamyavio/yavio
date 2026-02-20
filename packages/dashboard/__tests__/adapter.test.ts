import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock DB layer ──────────────────────────────────────────────────
const mockInsert = vi.fn();
const mockInsertValues = vi.fn();
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();
const mockSelectInnerJoin = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockDelete = vi.fn();
const mockDeleteWhere = vi.fn();

function resetChainMocks() {
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockResolvedValue(undefined);
  mockSelect.mockReturnValue({ from: mockSelectFrom });
  mockSelectFrom.mockReturnValue({
    where: mockSelectWhere,
    innerJoin: mockSelectInnerJoin,
  });
  mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
  mockSelectInnerJoin.mockReturnValue({ where: mockSelectWhere });
  mockSelectLimit.mockResolvedValue([]);
  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
  mockDeleteWhere.mockResolvedValue(undefined);
}

const mockDb = {
  insert: mockInsert,
  select: mockSelect,
  update: mockUpdate,
  delete: mockDelete,
};

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
}));

vi.mock("@yavio/db/schema", () => ({
  users: {
    id: "id",
    email: "email",
    name: "name",
    emailVerified: "emailVerified",
    avatarUrl: "avatarUrl",
    passwordHash: "passwordHash",
  },
  oauthAccounts: {
    userId: "userId",
    provider: "provider",
    providerAccountId: "providerAccountId",
    accessToken: "accessToken",
    refreshToken: "refreshToken",
    expiresAt: "expiresAt",
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

import type { Database } from "@yavio/db/client";
import type { Adapter } from "next-auth/adapters";
import { YavioAdapter } from "../lib/auth/adapter";

// ── tests ──────────────────────────────────────────────────────────
describe("YavioAdapter", () => {
  const adapter = YavioAdapter(mockDb as unknown as Database) as Required<Adapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
  });

  // ── createUser ───────────────────────────────────────────────────
  describe("createUser", () => {
    it("inserts user with generated UUID", async () => {
      await adapter.createUser({
        email: "test@example.com",
        name: "Test User",
        emailVerified: null,
        id: "",
      });

      expect(mockInsert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test-uuid-1234",
          email: "test@example.com",
          name: "Test User",
          emailVerified: false,
        }),
      );
    });

    it("converts truthy emailVerified to boolean true", async () => {
      await adapter.createUser({
        email: "t@t.com",
        emailVerified: new Date(),
        id: "",
      });

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: true }),
      );
    });

    it("maps image to avatarUrl", async () => {
      await adapter.createUser({
        email: "t@t.com",
        emailVerified: null,
        image: "https://avatar.example.com/pic.png",
        id: "",
      });

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ avatarUrl: "https://avatar.example.com/pic.png" }),
      );
    });

    it("returns AdapterUser with Date emailVerified for truthy values", async () => {
      const result = await adapter.createUser({
        email: "t@t.com",
        emailVerified: new Date("2024-01-01"),
        id: "",
      });

      expect(result.emailVerified).toBeInstanceOf(Date);
    });

    it("returns null emailVerified for falsy values", async () => {
      const result = await adapter.createUser({
        email: "t@t.com",
        emailVerified: null,
        id: "",
      });

      expect(result.emailVerified).toBeNull();
    });

    it("maps avatarUrl back to image in response", async () => {
      const result = await adapter.createUser({
        email: "t@t.com",
        emailVerified: null,
        image: "https://pic.com/a.png",
        id: "",
      });

      expect(result.image).toBe("https://pic.com/a.png");
    });

    it("sets null name when not provided", async () => {
      await adapter.createUser({
        email: "t@t.com",
        emailVerified: null,
        id: "",
      });

      expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ name: null }));
    });
  });

  // ── getUser ──────────────────────────────────────────────────────
  describe("getUser", () => {
    it("returns user when found", async () => {
      mockSelectLimit.mockResolvedValue([
        { id: "u-1", email: "t@t.com", name: "Bob", avatarUrl: null, emailVerified: true },
      ]);

      const result = await adapter.getUser("u-1");
      expect(result).not.toBeNull();
      expect(result?.id).toBe("u-1");
      expect(result?.email).toBe("t@t.com");
      expect(result?.emailVerified).toBeInstanceOf(Date);
    });

    it("returns null when not found", async () => {
      mockSelectLimit.mockResolvedValue([]);
      const result = await adapter.getUser("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ── getUserByEmail ───────────────────────────────────────────────
  describe("getUserByEmail", () => {
    it("returns user when found by email", async () => {
      mockSelectLimit.mockResolvedValue([
        { id: "u-2", email: "found@test.com", name: null, avatarUrl: null, emailVerified: false },
      ]);

      const result = await adapter.getUserByEmail("found@test.com");
      expect(result?.email).toBe("found@test.com");
      expect(result?.emailVerified).toBeNull(); // false → null
    });

    it("returns null when email not found", async () => {
      mockSelectLimit.mockResolvedValue([]);
      const result = await adapter.getUserByEmail("unknown@test.com");
      expect(result).toBeNull();
    });
  });

  // ── getUserByAccount ─────────────────────────────────────────────
  describe("getUserByAccount", () => {
    it("returns user when found by OAuth account", async () => {
      mockSelectLimit.mockResolvedValue([
        {
          user: {
            id: "u-3",
            email: "oauth@test.com",
            name: "OAuth User",
            avatarUrl: "https://pic.com",
            emailVerified: true,
          },
        },
      ]);

      const result = await adapter.getUserByAccount({
        providerAccountId: "google-123",
        provider: "google",
      });
      expect(result?.id).toBe("u-3");
      expect(result?.image).toBe("https://pic.com");
    });

    it("returns null when OAuth account not found", async () => {
      mockSelectLimit.mockResolvedValue([]);
      const result = await adapter.getUserByAccount({
        providerAccountId: "nope",
        provider: "github",
      });
      expect(result).toBeNull();
    });
  });

  // ── updateUser ───────────────────────────────────────────────────
  describe("updateUser", () => {
    it("throws when no ID provided", async () => {
      await expect(adapter.updateUser({ id: "" })).rejects.toThrow("User ID required");
    });

    it("updates and returns the user", async () => {
      mockSelectLimit.mockResolvedValue([
        { id: "u-1", email: "new@test.com", name: "Updated", avatarUrl: null, emailVerified: true },
      ]);

      const result = await adapter.updateUser({ id: "u-1", name: "Updated" });
      expect(result.name).toBe("Updated");
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ name: "Updated" }));
    });

    it("converts emailVerified to boolean", async () => {
      mockSelectLimit.mockResolvedValue([
        { id: "u-1", email: "t@t.com", name: null, avatarUrl: null, emailVerified: true },
      ]);

      await adapter.updateUser({ id: "u-1", emailVerified: new Date() });
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: true }));
    });

    it("maps image to avatarUrl on update", async () => {
      mockSelectLimit.mockResolvedValue([
        { id: "u-1", email: "t@t.com", name: null, avatarUrl: "new.png", emailVerified: false },
      ]);

      await adapter.updateUser({ id: "u-1", image: "new.png" });
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: "new.png" }));
    });

    it("throws when user not found after update", async () => {
      mockSelectLimit.mockResolvedValue([]);
      await expect(adapter.updateUser({ id: "u-gone" })).rejects.toThrow(
        "User not found after update",
      );
    });
  });

  // ── deleteUser ───────────────────────────────────────────────────
  describe("deleteUser", () => {
    it("deletes user by ID", async () => {
      await adapter.deleteUser("u-99");
      expect(mockDelete).toHaveBeenCalled();
      expect(mockDeleteWhere).toHaveBeenCalled();
    });
  });

  // ── linkAccount ──────────────────────────────────────────────────
  describe("linkAccount", () => {
    it("inserts OAuth account with correct fields", async () => {
      await adapter.linkAccount({
        userId: "u-1",
        provider: "google",
        providerAccountId: "g-123",
        access_token: "at-123",
        refresh_token: "rt-123",
        expires_at: 1700000000,
        type: "oauth",
      });

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "u-1",
          provider: "google",
          providerAccountId: "g-123",
          accessToken: "at-123",
          refreshToken: "rt-123",
        }),
      );
    });

    it("handles missing tokens", async () => {
      await adapter.linkAccount({
        userId: "u-1",
        provider: "github",
        providerAccountId: "gh-456",
        type: "oauth",
      });

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
        }),
      );
    });

    it("converts expires_at to Date", async () => {
      await adapter.linkAccount({
        userId: "u-1",
        provider: "google",
        providerAccountId: "g-123",
        expires_at: 1700000000,
        type: "oauth",
      });

      const call = mockInsertValues.mock.calls[0][0];
      expect(call.expiresAt).toBeInstanceOf(Date);
      expect(call.expiresAt.getTime()).toBe(1700000000 * 1000);
    });
  });

  // ── unlinkAccount ────────────────────────────────────────────────
  describe("unlinkAccount", () => {
    it("deletes by provider and providerAccountId", async () => {
      await adapter.unlinkAccount({
        provider: "google",
        providerAccountId: "g-123",
      });

      expect(mockDelete).toHaveBeenCalled();
      expect(mockDeleteWhere).toHaveBeenCalled();
    });
  });
});
