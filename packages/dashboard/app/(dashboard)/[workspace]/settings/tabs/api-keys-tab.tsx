"use client";

import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Check, Copy, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

interface ApiKeysTabProps {
  workspaceId: string;
}

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface ApiKey {
  id: string;
  keyPrefix: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Request failed");
    return r.json();
  });

export function ApiKeysTab({ workspaceId }: ApiKeysTabProps) {
  const { data: projectsData, isLoading: projectsLoading } = useSWR<{
    projects: Project[];
  }>(`/api/workspaces/${workspaceId}/projects`, fetcher);

  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const projects = projectsData?.projects ?? [];

  // Auto-select first project
  const projectId = selectedProjectId || (projects.length > 0 ? projects[0].id : "");

  const {
    data: keysData,
    isLoading: keysLoading,
    mutate: mutateKeys,
  } = useSWR<{ keys: ApiKey[] }>(
    projectId ? `/api/workspaces/${workspaceId}/projects/${projectId}/keys` : null,
    fetcher,
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [rawKey, setRawKey] = useState("");
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKey | null>(null);
  const [rotatedKey, setRotatedKey] = useState("");

  const keys = keysData?.keys ?? [];

  async function handleCreate() {
    setCreateLoading(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: keyName || undefined }),
    });

    if (!res.ok) {
      const body = await res.json();
      toast.error(body.error ?? "Failed to generate key");
      setCreateLoading(false);
      return;
    }

    const body = await res.json();
    setRawKey(body.apiKey.rawKey);
    setCreateLoading(false);
    mutateKeys();
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/keys/${revokeTarget.id}`,
      { method: "DELETE" },
    );

    if (!res.ok) {
      const body = await res.json();
      toast.error(body.error ?? "Failed to revoke key");
      setRevokeTarget(null);
      return;
    }

    toast.success("API key revoked");
    setRevokeTarget(null);
    mutateKeys();
  }

  async function handleRotate() {
    if (!rotateTarget) return;
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/keys/${rotateTarget.id}/rotate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    if (!res.ok) {
      const body = await res.json();
      toast.error(body.error ?? "Failed to rotate key");
      setRotateTarget(null);
      return;
    }

    const body = await res.json();
    setRotatedKey(body.apiKey.rawKey);
    setRotateTarget(null);
    mutateKeys();
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function closeCreateDialog() {
    setCreateOpen(false);
    setRawKey("");
    setKeyName("");
    setCopied(false);
  }

  function closeRotatedDialog() {
    setRotatedKey("");
    setCopied(false);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>Manage API keys for your projects.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Project selector */}
          <div className="space-y-2">
            <Label htmlFor="key-project">Project</Label>
            {projectsLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Select value={projectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger id="key-project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {projectId && (
            <>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1 h-4 w-4" />
                  Generate Key
                </Button>
              </div>

              {keysLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Last Used</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keys.map((key) => {
                      const isRevoked = key.revokedAt !== null;
                      return (
                        <TableRow key={key.id}>
                          <TableCell className="font-mono text-sm">{key.keyPrefix}...</TableCell>
                          <TableCell>{key.name ?? "—"}</TableCell>
                          <TableCell>{new Date(key.createdAt).toLocaleDateString()}</TableCell>
                          <TableCell>
                            {key.lastUsedAt
                              ? new Date(key.lastUsedAt).toLocaleDateString()
                              : "Never"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={isRevoked ? "destructive" : "secondary"}>
                              {isRevoked ? "Revoked" : "Active"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {!isRevoked && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => setRotateTarget(key)}>
                                    Rotate
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-destructive"
                                    onClick={() => setRevokeTarget(key)}
                                  >
                                    Revoke
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {keys.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No API keys yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Create key dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) closeCreateDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rawKey ? "API Key Generated" : "Generate API Key"}</DialogTitle>
            <DialogDescription>
              {rawKey
                ? "Copy your API key now. It won't be shown again."
                : "Create a new API key for this project."}
            </DialogDescription>
          </DialogHeader>
          {rawKey ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md border bg-muted p-3 font-mono text-sm">
                <span className="flex-1 break-all">{rawKey}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0"
                  onClick={() => handleCopy(rawKey)}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <DialogFooter>
                <Button onClick={closeCreateDialog}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">Name (optional)</Label>
                <Input
                  id="key-name"
                  placeholder="e.g. Production"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={createLoading}>
                  {createLoading ? "Generating..." : "Generate"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke key confirmation */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke API Key"
        description={`Are you sure you want to revoke the key "${revokeTarget?.keyPrefix}..."? Applications using this key will stop working.`}
        actionLabel="Revoke"
        onConfirm={handleRevoke}
      />

      {/* Rotate key confirmation */}
      <ConfirmDialog
        open={rotateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null);
        }}
        title="Rotate API Key"
        description={`This will revoke the current key "${rotateTarget?.keyPrefix}..." and generate a new one.`}
        actionLabel="Rotate"
        onConfirm={handleRotate}
      />

      {/* Rotated key display */}
      <Dialog
        open={rotatedKey !== ""}
        onOpenChange={(open) => {
          if (!open) closeRotatedDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API Key</DialogTitle>
            <DialogDescription>
              Copy your new API key now. It won't be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border bg-muted p-3 font-mono text-sm">
              <span className="flex-1 break-all">{rotatedKey}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={() => handleCopy(rotatedKey)}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={closeRotatedDialog}>Done</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
