"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Check, Copy, Plug } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface McpConnectDialogProps {
  /** This deployment's MCP server URL (mcpResourceUri()), never hardcoded. */
  url: string;
  collapsed: boolean;
}

/**
 * Discreet pointer at the platform's own MCP server (#53): the analytics
 * of this deployment are queryable from any MCP client that supports
 * remote servers with OAuth. The URL differs per deployment, so it is
 * passed in from the server-rendered layout.
 */
export function McpConnectDialog({ url, collapsed }: McpConnectDialogProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          title={collapsed ? "Connect an MCP client" : undefined}
          className={cn(
            "flex h-9 w-full items-center gap-3 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed ? "justify-center px-2" : "px-3",
          )}
        >
          <Plug className="h-4 w-4 flex-shrink-0" />
          {!collapsed && <span className="truncate">Connect an MCP client</span>}
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Query your analytics from an MCP client</DialogTitle>
          <DialogDescription>
            This Yavio deployment serves an MCP server. Add it to Claude, ChatGPT or any other
            client that supports remote MCP servers with OAuth, and ask about your usage data in
            plain language.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Server URL
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded border bg-muted px-2.5 py-1.5 font-mono text-xs">
                {url}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={copy}
                className="gap-1.5 text-xs"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              In your client, add a custom connector (Claude: Settings → Connectors; ChatGPT:
              Settings → Apps &amp; Connectors) and paste the server URL.
            </li>
            <li>
              The client opens the Yavio consent screen: sign in, pick the workspace to share and
              allow access.
            </li>
            <li>
              Ask away — for example which tools were called most this week, or why a tool is
              erroring.
            </li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Access is read-only and scoped to one workspace. It ends when you leave the workspace.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
