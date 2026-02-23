"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  Filter,
  GitBranch,
  LayoutDashboard,
  Settings,
  User,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Workspace {
  id: string;
  name: string;
  slug: string;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  workspaceId: string;
}

interface SidebarProps {
  workspaces: Workspace[];
  projects: Project[];
}

const analyticsNavItems = [
  { path: "overview", label: "Overview", icon: LayoutDashboard },
  { path: "tools", label: "Tools", icon: Wrench },
  { path: "funnels", label: "Funnels", icon: Filter, comingSoon: true },
  { path: "users", label: "Users", icon: Users },
  { path: "paths", label: "Paths", icon: GitBranch, comingSoon: true },
  { path: "live", label: "Live", icon: Activity },
  { path: "errors", label: "Errors", icon: AlertTriangle },
];

export function Sidebar({ workspaces, projects }: SidebarProps) {
  const pathname = usePathname();
  const params = useParams();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const currentWorkspaceSlug = (params.workspace as string | undefined) ?? workspaces[0]?.slug;
  const currentWorkspace = workspaces.find((ws) => ws.slug === currentWorkspaceSlug);
  const workspaceProjects = currentWorkspace
    ? projects.filter((p) => p.workspaceId === currentWorkspace.id)
    : [];
  const currentProjectSlug = (params.project as string | undefined) ?? workspaceProjects[0]?.slug;

  const basePath =
    currentWorkspaceSlug && currentProjectSlug
      ? `/${currentWorkspaceSlug}/${currentProjectSlug}`
      : "";

  return (
    <aside className="flex h-screen w-56 flex-shrink-0 flex-col border-r bg-muted/40">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/" className="text-lg font-bold">
          Yavio
        </Link>
      </div>

      <div className="space-y-2 p-3">
        {mounted ? (
          <>
            <Select
              value={currentWorkspaceSlug ?? ""}
              onValueChange={(slug) => {
                const ws = workspaces.find((w) => w.slug === slug);
                const wsProjects = ws ? projects.filter((p) => p.workspaceId === ws.id) : [];
                const project = wsProjects[0];
                if (project) {
                  router.push(`/${slug}/${project.slug}/overview`);
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.slug}>
                    {ws.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {currentWorkspaceSlug && workspaceProjects.length > 0 && (
              <Select
                value={currentProjectSlug ?? ""}
                onValueChange={(slug) => {
                  router.push(`/${currentWorkspaceSlug}/${slug}/overview`);
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {workspaceProjects.map((proj) => (
                    <SelectItem key={proj.id} value={proj.slug}>
                      {proj.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </>
        ) : (
          <>
            <div className="flex h-8 items-center rounded-md border border-input px-3 text-xs">
              {currentWorkspace?.name ?? "Select workspace"}
            </div>
            {currentWorkspaceSlug && workspaceProjects.length > 0 && (
              <div className="flex h-8 items-center rounded-md border border-input px-3 text-xs">
                {workspaceProjects.find((p) => p.slug === currentProjectSlug)?.name ??
                  "Select project"}
              </div>
            )}
          </>
        )}
      </div>

      <Separator />

      <nav className="flex-1 space-y-1 p-2">
        {analyticsNavItems.map((item) => {
          const Icon = item.icon;
          const href = `${basePath}/${item.path}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={item.path}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
              {item.comingSoon && (
                <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  Soon
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <Separator />

      <div className="space-y-1 p-2">
        {currentWorkspaceSlug && (
          <Link
            href={`/${currentWorkspaceSlug}/settings`}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              pathname.includes("/settings") && !pathname.includes("/settings/account")
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
        )}
        <Link
          href="/settings/account"
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            pathname === "/settings/account"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <User className="h-4 w-4" />
          Account
        </Link>
      </div>
    </aside>
  );
}
