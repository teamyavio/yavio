import { describe, expect, it } from "vitest";
import { detectPlatform } from "../core/platform.js";

describe("detectPlatform", () => {
  describe("client name detection (highest priority)", () => {
    it("detects ChatGPT from client name", () => {
      expect(detectPlatform({ clientName: "ChatGPT-Client" })).toBe("chatgpt");
    });

    it("detects Claude from client name", () => {
      expect(detectPlatform({ clientName: "claude-desktop" })).toBe("claude");
    });

    it("detects Cursor from client name", () => {
      expect(detectPlatform({ clientName: "Cursor-IDE" })).toBe("cursor");
    });

    it("detects VS Code from client name", () => {
      expect(detectPlatform({ clientName: "Visual Studio Code" })).toBe("vscode");
    });

    it("detects Windsurf from client name", () => {
      expect(detectPlatform({ clientName: "Windsurf-Editor" })).toBe("windsurf");
    });

    it("detects Codeium as Windsurf", () => {
      expect(detectPlatform({ clientName: "Codeium-Client" })).toBe("windsurf");
    });
  });

  describe("user-agent detection", () => {
    it("detects ChatGPT from user-agent", () => {
      expect(detectPlatform({ userAgent: "Mozilla/5.0 ChatGPT-Plugin" })).toBe("chatgpt");
    });

    it("detects Cursor from user-agent", () => {
      expect(detectPlatform({ userAgent: "Cursor/1.0" })).toBe("cursor");
    });
  });

  describe("origin detection", () => {
    it("detects ChatGPT from origin", () => {
      expect(detectPlatform({ origin: "https://chatgpt.com" })).toBe("chatgpt");
    });

    it("detects Claude from origin", () => {
      expect(detectPlatform({ origin: "https://claude.ai" })).toBe("claude");
    });
  });

  describe("priority ordering", () => {
    it("client name wins over user-agent", () => {
      expect(
        detectPlatform({
          clientName: "claude-desktop",
          userAgent: "Cursor/1.0",
        }),
      ).toBe("claude");
    });

    it("user-agent wins over origin", () => {
      expect(
        detectPlatform({
          userAgent: "Cursor/1.0",
          origin: "https://claude.ai",
        }),
      ).toBe("cursor");
    });
  });

  describe("fallback", () => {
    it("returns unknown with no signals", () => {
      expect(detectPlatform({})).toBe("unknown");
    });

    it("returns unknown with unrecognised signals", () => {
      expect(detectPlatform({ clientName: "SomeOtherClient" })).toBe("unknown");
    });
  });
});
