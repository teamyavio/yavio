import { describe, expect, it } from "vitest";
import { detectPlatform, platformValues } from "../core/platform.js";

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

    it("detects Claude Code from its real client name", () => {
      // Claude Code sends clientInfo.name "claude-code" — must not collapse
      // into the generic "claude" bucket despite containing "claude".
      expect(detectPlatform({ clientName: "claude-code" })).toBe("claude-code");
    });

    it("detects claude.ai / Claude Desktop from their real client name", () => {
      // Both claude.ai and Claude Desktop send clientInfo.name "claude-ai".
      expect(detectPlatform({ clientName: "claude-ai" })).toBe("claude");
    });

    it("detects Codex from its real client name", () => {
      // Codex sends clientInfo.name "codex-mcp-client". The "client"
      // substring must not be mistaken for Cline.
      expect(detectPlatform({ clientName: "codex-mcp-client" })).toBe("codex");
    });

    it("detects opencode from its real client name", () => {
      expect(detectPlatform({ clientName: "opencode" })).toBe("opencode");
    });

    it("detects Cline from its real client name", () => {
      expect(detectPlatform({ clientName: "@cline/core" })).toBe("cline");
    });

    it("detects Continue from its real client name", () => {
      expect(detectPlatform({ clientName: "continue-client" })).toBe("continue");
    });

    it("detects Gemini from the CLI's real client name", () => {
      expect(detectPlatform({ clientName: "gemini-cli-mcp-client" })).toBe("gemini");
    });

    it("detects Zed from its real client name", () => {
      expect(detectPlatform({ clientName: "Zed" })).toBe("zed");
    });

    it("does not match 'zed' as a substring of longer names", () => {
      expect(detectPlatform({ clientName: "authorized-client" })).toBe("unknown");
    });

    it("detects Cursor before VS Code for 'cursor-vscode'", () => {
      expect(detectPlatform({ clientName: "cursor-vscode" })).toBe("cursor");
    });

    it("treats the Python SDK default identity as unknown", () => {
      // Clients that never set clientInfo (e.g. Hermes) send the SDK
      // default name "mcp" — not attributable to any platform.
      expect(detectPlatform({ clientName: "mcp" })).toBe("unknown");
    });
  });

  describe("user-agent detection", () => {
    it("detects ChatGPT from user-agent", () => {
      expect(detectPlatform({ userAgent: "Mozilla/5.0 ChatGPT-Plugin" })).toBe("chatgpt");
    });

    it("detects Cursor from user-agent", () => {
      expect(detectPlatform({ userAgent: "Cursor/1.0" })).toBe("cursor");
    });

    it("detects Zed from a 'zed/<version>' user-agent", () => {
      expect(detectPlatform({ userAgent: "Zed/0.120.0" })).toBe("zed");
    });
  });

  describe("origin detection", () => {
    it("detects ChatGPT from origin", () => {
      expect(detectPlatform({ origin: "https://chatgpt.com" })).toBe("chatgpt");
    });

    it("detects Claude from origin", () => {
      expect(detectPlatform({ origin: "https://claude.ai" })).toBe("claude");
    });

    it("detects Gemini from origin", () => {
      expect(detectPlatform({ origin: "https://gemini.google.com" })).toBe("gemini");
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

  describe("platformValues export", () => {
    it("has no duplicates and includes unknown", () => {
      expect(new Set(platformValues).size).toBe(platformValues.length);
      expect(platformValues).toContain("unknown");
    });

    it("every detectable platform is listed", () => {
      const detected = [
        detectPlatform({ clientName: "chatgpt" }),
        detectPlatform({ clientName: "codex-mcp-client" }),
        detectPlatform({ clientName: "claude-ai" }),
        detectPlatform({ clientName: "claude-code" }),
        detectPlatform({ clientName: "cursor-vscode" }),
        detectPlatform({ clientName: "gemini-cli-mcp-client" }),
        detectPlatform({ clientName: "opencode" }),
        detectPlatform({ clientName: "vscode" }),
        detectPlatform({ clientName: "windsurf" }),
        detectPlatform({ clientName: "@cline/core" }),
        detectPlatform({ clientName: "continue-client" }),
        detectPlatform({ clientName: "Zed" }),
      ];
      for (const platform of detected) {
        expect(platformValues).toContain(platform);
      }
      // All non-"unknown" values are reachable
      expect(new Set(detected).size).toBe(platformValues.length - 1);
    });
  });
});
