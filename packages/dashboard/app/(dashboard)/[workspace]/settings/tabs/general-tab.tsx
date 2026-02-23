"use client";

import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { DangerZone } from "@/components/settings/danger-zone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type UpdateWorkspaceInput, updateWorkspaceSchema } from "@/lib/workspace/validation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

interface GeneralTabProps {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  isOwner: boolean;
}

export function GeneralTab({
  workspaceId,
  workspaceName,
  workspaceSlug,
  isOwner,
}: GeneralTabProps) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState("");

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateWorkspaceInput>({
    resolver: zodResolver(updateWorkspaceSchema),
    defaultValues: {
      name: workspaceName,
      slug: workspaceSlug,
    },
  });

  async function onSubmit(data: UpdateWorkspaceInput) {
    setError("");
    const res = await fetch(`/api/workspaces/${workspaceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "Failed to update workspace");
      return;
    }

    const body = await res.json();
    toast.success("Workspace updated");

    if (body.workspace?.slug && body.workspace.slug !== workspaceSlug) {
      router.replace(`/${body.workspace.slug}/settings?tab=general`);
    } else {
      router.refresh();
    }
  }

  async function handleDelete() {
    const res = await fetch(`/api/workspaces/${workspaceId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const body = await res.json();
      toast.error(body.error ?? "Failed to delete workspace");
      return;
    }

    toast.success("Workspace deleted");
    router.push("/");
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Update your workspace name and URL slug.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="ws-name">Name</Label>
              <Input id="ws-name" {...register("name")} />
              {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-slug">Slug</Label>
              <Input id="ws-slug" {...register("slug")} />
              {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
            </div>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : "Save Changes"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isOwner && (
        <>
          <Separator />
          <DangerZone description="Deleting a workspace permanently removes all projects, API keys, members, and analytics data. This action cannot be undone.">
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              Delete Workspace
            </Button>
            <ConfirmDialog
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              title="Delete Workspace"
              description={`This will permanently delete "${workspaceName}" and all associated data. This action cannot be undone.`}
              confirmText={workspaceName}
              actionLabel="Delete Workspace"
              onConfirm={handleDelete}
            />
          </DangerZone>
        </>
      )}
    </div>
  );
}
