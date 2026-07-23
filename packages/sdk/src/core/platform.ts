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
