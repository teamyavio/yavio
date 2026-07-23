/**
 * All platform values the SDK can emit. Single source of truth — the
 * dashboard filter imports this list, so the two can never drift apart.
 *
 * Every entry is backed by a verified client identity (the `clientInfo.name`
 * sent in the MCP initialize handshake):
 * - "chatgpt"      ChatGPT apps/connectors (also matched via user agent/origin)
 * - "codex"        OpenAI Codex — sends "codex-mcp-client"
 * - "claude"       claude.ai and Claude Desktop — both send "claude-ai"
 * - "claude-code"  Claude Code — sends "claude-code"
 * - "cursor"       Cursor — client name contains "cursor" (e.g. "cursor-vscode")
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
  "opencode",
  "vscode",
  "windsurf",
  "cline",
  "continue",
  "zed",
  "unknown",
] as const;

export type Platform = (typeof platformValues)[number];

export interface PlatformSignals {
  userAgent?: string;
  headers?: Record<string, string>;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  origin?: string;
}

/**
 * Match a client name or user-agent string to a platform.
 *
 * Order matters: specific product names must be checked before generic
 * vendor patterns they contain — "claude-code" also contains "claude",
 * and Cursor identifies as "cursor-vscode" which also contains "vscode".
 */
function matchIdentity(raw: string): Platform | undefined {
  const name = raw.toLowerCase();
  if (name.includes("claude-code")) return "claude-code";
  if (name.includes("codex")) return "codex";
  if (name.includes("opencode")) return "opencode";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("claude") || name.includes("anthropic")) return "claude";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("windsurf") || name.includes("codeium")) return "windsurf";
  if (name.includes("cline")) return "cline";
  if (name.includes("continue")) return "continue";
  if (name.includes("vscode") || name.includes("visual studio code")) return "vscode";
  // "zed" is too short for substring matching — require an exact name
  // or a "zed/<version>" user-agent prefix.
  if (name === "zed" || name.startsWith("zed/")) return "zed";
  return undefined;
}

/**
 * Detect the MCP client platform from available signals.
 *
 * Priority: clientName > userAgent > origin > unknown.
 */
export function detectPlatform(signals: PlatformSignals): Platform {
  // 1. Client name (highest reliability — from MCP initialize)
  if (signals.clientName) {
    const match = matchIdentity(signals.clientName);
    if (match) return match;
  }

  // 2. User-Agent header patterns
  if (signals.userAgent) {
    const match = matchIdentity(signals.userAgent);
    if (match) return match;
  }

  // 3. Request origin / referrer
  if (signals.origin) {
    const origin = signals.origin.toLowerCase();
    if (origin.includes("openai.com") || origin.includes("chatgpt.com")) return "chatgpt";
    if (origin.includes("claude.ai") || origin.includes("anthropic.com")) return "claude";
  }

  return "unknown";
}
