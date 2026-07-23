/**
 * All platform values the SDK can emit — the single source of truth shared
 * by SDK detection and the dashboard filter, so the two can never drift.
 *
 * Every entry is backed by a verified client identity (the `clientInfo.name`
 * sent in the MCP initialize handshake):
 * - "chatgpt"      ChatGPT apps/connectors (also matched via user agent/origin)
 * - "codex"        OpenAI Codex — sends "codex-mcp-client"
 * - "claude"       claude.ai and Claude Desktop — both send "claude-ai"
 * - "claude-code"  Claude Code — sends "claude-code"
 * - "cursor"       Cursor — client name contains "cursor" (e.g. "cursor-vscode")
 * - "gemini"       Google Gemini app and Enterprise connector
 * - "gemini-cli"   Gemini CLI — sends "gemini-cli-mcp-client"
 * - "opencode"     opencode — sends "opencode"
 * - "vscode"       VS Code (Copilot agent mode and other VS Code MCP clients)
 * - "windsurf"     Windsurf (formerly Codeium)
 * - "cline"        Cline — sends "@cline/core"
 * - "continue"     Continue — sends "continue-client"
 * - "zed"          Zed — sends "Zed"
 * - "unknown"      no recognised signal (includes clients that send no usable
 *                  identity, e.g. Python SDK default "mcp")
 */
export const platformValues = [
  "chatgpt",
  "codex",
  "claude",
  "claude-code",
  "cursor",
  "gemini",
  "gemini-cli",
  "opencode",
  "vscode",
  "windsurf",
  "cline",
  "continue",
  "zed",
  "unknown",
] as const;

export type Platform = (typeof platformValues)[number];
