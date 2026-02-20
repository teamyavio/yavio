export type Platform = "chatgpt" | "claude" | "cursor" | "vscode" | "windsurf" | "unknown";

export interface PlatformSignals {
  userAgent?: string;
  headers?: Record<string, string>;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  origin?: string;
}

/**
 * Detect the MCP client platform from available signals.
 *
 * Priority: clientName > userAgent > origin > unknown.
 */
export function detectPlatform(signals: PlatformSignals): Platform {
  // 1. Client name (highest reliability — from MCP initialize)
  if (signals.clientName) {
    const name = signals.clientName.toLowerCase();
    if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
    if (name.includes("claude") || name.includes("anthropic")) return "claude";
    if (name.includes("cursor")) return "cursor";
    if (name.includes("vscode") || name.includes("visual studio code")) return "vscode";
    if (name.includes("windsurf") || name.includes("codeium")) return "windsurf";
  }

  // 2. User-Agent header patterns
  if (signals.userAgent) {
    const ua = signals.userAgent.toLowerCase();
    if (ua.includes("chatgpt") || ua.includes("openai")) return "chatgpt";
    if (ua.includes("claude") || ua.includes("anthropic")) return "claude";
    if (ua.includes("cursor")) return "cursor";
    if (ua.includes("vscode") || ua.includes("visual studio code")) return "vscode";
    if (ua.includes("windsurf") || ua.includes("codeium")) return "windsurf";
  }

  // 3. Request origin / referrer
  if (signals.origin) {
    const origin = signals.origin.toLowerCase();
    if (origin.includes("openai.com") || origin.includes("chatgpt.com")) return "chatgpt";
    if (origin.includes("claude.ai") || origin.includes("anthropic.com")) return "claude";
  }

  return "unknown";
}
