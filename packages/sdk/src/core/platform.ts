import type { Platform } from "@yavio/shared/platform";

// The platform list lives in @yavio/shared so the dashboard can import it
// without pulling in server-only SDK code. Re-exported here for npm consumers.
export { platformValues } from "@yavio/shared/platform";
export type { Platform } from "@yavio/shared/platform";

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
  if (name.includes("gemini-cli")) return "gemini-cli";
  if (name.includes("gemini")) return "gemini";
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
 * Priority: OpenAI connector marker (any signal) > clientName > userAgent >
 * origin > unknown.
 */
export function detectPlatform(signals: PlatformSignals): Platform {
  // 0. OpenAI's hosted MCP connector ("openai-mcp") is decisive over every
  // per-signal match: all ChatGPT surfaces (chat, ChatGPT Work agents, Codex
  // inside the ChatGPT app) reach the server through it, and sessions driven
  // by the Codex runtime present Codex identifiers — user-agent
  // "openai-mcp/1.0.0 (Codex)", clientInfo.name "codex-mcp-client" — that are
  // indistinguishable from the standalone Codex CLI signal-by-signal. The
  // runtime marker even flaps between requests of a single conversation, so
  // it cannot be a platform: connector traffic is "chatgpt", and "codex" is
  // reserved for a Codex CLI connecting directly (no connector marker).
  const connectorScope = `${signals.clientName ?? ""} ${signals.userAgent ?? ""}`.toLowerCase();
  if (connectorScope.includes("openai-mcp")) return "chatgpt";

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
    if (origin.includes("gemini.google.com")) return "gemini";
  }

  return "unknown";
}
