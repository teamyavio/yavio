"use client";

import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type CreateProjectInput,
  type UpdateProjectInput,
  createProjectSchema,
  updateProjectSchema,
} from "@/lib/project/validation";
import { zodResolver } from "@hookform/resolvers/zod";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import useSWR from "swr";

interface ProjectsTabProps {
  workspaceId: string;
  workspaceSlug: string;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Request failed");
    return r.json();
  });

export function ProjectsTab({ workspaceId, workspaceSlug }: ProjectsTabProps) {
  const { data, isLoading, mutate } = useSWR<{ projects: Project[] }>(
    `/api/workspaces/${workspaceId}/projects`,
    fetcher,
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  const projects = data?.projects ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Projects</CardTitle>
            <CardDescription>Manage projects within this workspace.</CardDescription>
          </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1 h-4 w-4" />
                New Project
              </Button>
            </DialogTrigger>
            <CreateProjectDialog
              workspaceId={workspaceId}
              onSuccess={() => {
                setCreateOpen(false);
                mutate();
              }}
            />
          </Dialog>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="font-medium">{project.name}</TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {project.slug}
                    </TableCell>
                    <TableCell>{new Date(project.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditTarget(project)}>
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(project)}
                          >
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {projects.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No projects yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit project dialog */}
      {editTarget && (
        <EditProjectDialog
          workspaceId={workspaceId}
          project={editTarget}
          open={editTarget !== null}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          onSuccess={() => {
            setEditTarget(null);
            mutate();
          }}
        />
      )}

      {/* Delete project confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Project"
        description={`This will permanently delete "${deleteTarget?.name}" and all associated API keys and analytics data.`}
        confirmText={deleteTarget?.name}
        actionLabel="Delete Project"
        onConfirm={async () => {
          if (!deleteTarget) return;
          const res = await fetch(`/api/workspaces/${workspaceId}/projects/${deleteTarget.id}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            const body = await res.json();
            toast.error(body.error ?? "Failed to delete project");
            return;
          }
          toast.success("Project deleted");
          setDeleteTarget(null);
          mutate();
        }}
      />
    </div>
  );
}

function CreateProjectDialog({
  workspaceId,
  onSuccess,
}: {
  workspaceId: string;
  onSuccess: () => void;
}) {
  const [error, setError] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
  });

  async function onSubmit(data: CreateProjectInput) {
    setError("");
    const res = await fetch(`/api/workspaces/${workspaceId}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "Failed to create project");
      return;
    }

    toast.success("Project created");
    reset();
    onSuccess();
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create Project</DialogTitle>
        <DialogDescription>Add a new project to this workspace.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}
        <div className="space-y-2">
          <Label htmlFor="proj-name">Name</Label>
          <Input id="proj-name" {...register("name")} />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="proj-slug">Slug (optional)</Label>
          <Input id="proj-slug" {...register("slug")} />
          {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function EditProjectDialog({
  workspaceId,
  project,
  open,
  onOpenChange,
  onSuccess,
}: {
  workspaceId: string;
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [error, setError] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UpdateProjectInput>({
    resolver: zodResolver(updateProjectSchema),
    defaultValues: {
      name: project.name,
      slug: project.slug,
    },
  });

  async function onSubmit(data: UpdateProjectInput) {
    setError("");
    const res = await fetch(`/api/workspaces/${workspaceId}/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "Failed to update project");
      return;
    }

    toast.success("Project updated");
    onSuccess();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Project</DialogTitle>
          <DialogDescription>Update the project name and slug.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
          <div className="space-y-2">
            <Label htmlFor="edit-proj-name">Name</Label>
            <Input id="edit-proj-name" {...register("name")} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-proj-slug">Slug</Label>
            <Input id="edit-proj-slug" {...register("slug")} />
            {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
