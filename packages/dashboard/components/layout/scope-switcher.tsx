"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  workspaceId: string;
}

interface ScopeSwitcherProps {
  workspaces: Workspace[];
  projects: Project[];
  currentWorkspaceSlug?: string;
  currentProjectSlug?: string;
  collapsed: boolean;
}

/**
 * Single switcher for the full scope (workspace + project): the closed
 * trigger shows where you are, the open menu shows every project the
 * user can reach, grouped by workspace, so a complete scope switch is
 * one click. Pure navigation — settings live in the sidebar.
 */
export function ScopeSwitcher({
  workspaces,
  projects,
  currentWorkspaceSlug,
  currentProjectSlug,
  collapsed,
}: ScopeSwitcherProps) {
  const [open, setOpen] = useState(false);
  const currentWorkspace = workspaces.find((ws) => ws.slug === currentWorkspaceSlug);
  const currentProject = projects.find(
    (p) => p.workspaceId === currentWorkspace?.id && p.slug === currentProjectSlug,
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {collapsed ? (
          <button
            type="button"
            title={
              currentWorkspace && currentProject
                ? `${currentWorkspace.name} / ${currentProject.name}`
                : "Switch project"
            }
            className="flex h-9 w-full items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ChevronsUpDown className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                {currentWorkspace?.name ?? "Workspace"}
              </span>
              <span className="block truncate text-sm font-medium leading-tight">
                {currentProject?.name ?? "Select project"}
              </span>
            </span>
            <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-64 overflow-y-auto">
        {workspaces.map((ws) => {
          const wsProjects = projects.filter((p) => p.workspaceId === ws.id);
          return (
            <div key={ws.id}>
              <div className="px-2 pt-2 pb-1">
                <span className="block truncate text-xs font-medium text-muted-foreground">
                  {ws.name}
                </span>
              </div>
              {wsProjects.map((proj) => {
                const active = ws.slug === currentWorkspaceSlug && proj.slug === currentProjectSlug;
                return (
                  <DropdownMenuItem asChild key={proj.id}>
                    <Link href={`/${ws.slug}/${proj.slug}/overview`}>
                      <span className="truncate">{proj.name}</span>
                      {active && <Check className="ml-auto h-4 w-4" />}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
              {wsProjects.length === 0 && (
                <p className="px-2 pb-1.5 text-xs text-muted-foreground">No projects yet</p>
              )}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
