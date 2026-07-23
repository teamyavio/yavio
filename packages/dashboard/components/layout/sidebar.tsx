"use client";

import { ScopeSwitcher } from "@/components/layout/scope-switcher";
import { YavioLogo } from "@/components/layout/yavio-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CreditCard,
  Filter,
  FolderKanban,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  User,
  Users,
  Wrench,
} from "lucide-react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

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

interface SidebarProps {
  workspaces: Workspace[];
  projects: Project[];
  user: { name: string | null; email: string };
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

const ROLE_LEVEL: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

const workspaceSettingsItems = [
  { tab: "general", label: "General", icon: Settings, minRole: ROLE_LEVEL.admin },
  { tab: "members", label: "Members", icon: Users, minRole: ROLE_LEVEL.admin },
  { tab: "projects", label: "Projects", icon: FolderKanban, minRole: ROLE_LEVEL.member },
  { tab: "api-keys", label: "API Keys", icon: KeyRound, minRole: ROLE_LEVEL.member },
  { tab: "billing", label: "Billing", icon: CreditCard, minRole: ROLE_LEVEL.viewer },
];

const COLLAPSED_STORAGE_KEY = "yavio.sidebar-collapsed";
// Below this viewport width the sidebar starts collapsed so a
// half-screen browser window keeps its space for content.
const WIDE_VIEWPORT_QUERY = "(min-width: 1024px)";

// Settings routes carry no project (and the account page no workspace)
// in the URL, so the sidebar remembers the last visited pair — without
// this, settings pages silently fall back to the first project.
const LAST_WORKSPACE_KEY = "yavio.last-workspace";
const lastProjectKey = (workspaceSlug: string) => `yavio.last-project.${workspaceSlug}`;

export function Sidebar({ workspaces, projects, user }: SidebarProps) {
  const pathname = usePathname();
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isWide, setIsWide] = useState(true);

  useEffect(() => {
    setMounted(true);
    const media = window.matchMedia(WIDE_VIEWPORT_QUERY);
    const apply = () => {
      setIsWide(media.matches);
      setCollapsed(media.matches ? localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1" : true);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      // Only persist the preference for wide windows; collapsing in a
      // narrow window is automatic and shouldn't stick.
      if (isWide) {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, prev ? "0" : "1");
      }
      return !prev;
    });
  }

  const paramWorkspace = params.workspace as string | undefined;
  const paramProject = params.project as string | undefined;

  useEffect(() => {
    if (paramWorkspace) {
      localStorage.setItem(LAST_WORKSPACE_KEY, paramWorkspace);
      if (paramProject) {
        localStorage.setItem(lastProjectKey(paramWorkspace), paramProject);
      }
    }
  }, [paramWorkspace, paramProject]);

  // localStorage is only consulted after mount so the first client
  // render matches the server-rendered HTML.
  const rememberedWorkspace = mounted ? localStorage.getItem(LAST_WORKSPACE_KEY) : null;
  const currentWorkspaceSlug =
    paramWorkspace ??
    (rememberedWorkspace && workspaces.some((ws) => ws.slug === rememberedWorkspace)
      ? rememberedWorkspace
      : undefined) ??
    workspaces[0]?.slug;
  const currentWorkspace = workspaces.find((ws) => ws.slug === currentWorkspaceSlug);
  const workspaceProjects = currentWorkspace
    ? projects.filter((p) => p.workspaceId === currentWorkspace.id)
    : [];
  const rememberedProject =
    mounted && currentWorkspaceSlug
      ? localStorage.getItem(lastProjectKey(currentWorkspaceSlug))
      : null;
  const currentProjectSlug =
    paramProject ??
    (rememberedProject && workspaceProjects.some((p) => p.slug === rememberedProject)
      ? rememberedProject
      : undefined) ??
    workspaceProjects[0]?.slug;

  const basePath =
    currentWorkspaceSlug && currentProjectSlug
      ? `/${currentWorkspaceSlug}/${currentProjectSlug}`
      : "";

  // Settings pages are workspace- (or account-)scoped: the project
  // selector has no honest job there, so it is replaced by an explicit
  // way back to the project.
  const inSettings = pathname === "/settings/account" || /^\/[^/]+\/settings/.test(pathname);
  const currentProjectName = workspaceProjects.find((p) => p.slug === currentProjectSlug)?.name;
  const displayName = user.name?.trim() || user.email;
  const initial = (displayName[0] ?? "?").toUpperCase();

  const roleLevel = ROLE_LEVEL[currentWorkspace?.role ?? ""] ?? 0;
  const visibleSettingsItems = workspaceSettingsItems.filter((item) => roleLevel >= item.minRole);
  const defaultSettingsTab = visibleSettingsItems[0]?.tab;
  const onWorkspaceSettings = currentWorkspaceSlug
    ? pathname === `/${currentWorkspaceSlug}/settings`
    : false;
  const activeSettingsTab = onWorkspaceSettings
    ? (searchParams.get("tab") ?? defaultSettingsTab)
    : null;

  return (
    <aside
      className={cn(
        "flex h-full flex-shrink-0 flex-col border-r bg-muted/40 transition-[width] duration-200",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <div
        className={cn(
          "flex items-center border-b",
          collapsed ? "flex-col gap-1 pt-3 pb-2" : "h-14 justify-between px-4",
        )}
      >
        <Link
          href="/"
          title={collapsed ? "Yavio" : undefined}
          className={cn("flex items-center gap-2 text-lg font-bold", collapsed && "p-1.5")}
        >
          <YavioLogo className="h-5 w-5" />
          {!collapsed && "Yavio"}
        </Link>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      {!inSettings && (
        <div className={collapsed ? "p-2" : "p-3"}>
          <ScopeSwitcher
            workspaces={workspaces}
            projects={projects}
            currentWorkspaceSlug={currentWorkspaceSlug}
            currentProjectSlug={currentProjectSlug}
            collapsed={collapsed}
          />
        </div>
      )}

      {!inSettings && <Separator />}

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {inSettings ? (
          <>
            {basePath && (
              <Link
                href={`${basePath}/overview`}
                title={
                  collapsed
                    ? `Back to ${currentProjectName ?? "project"}`
                    : (currentProjectName ?? undefined)
                }
                className={cn(
                  "mb-2 flex h-9 items-center gap-3 rounded-md border text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                  collapsed ? "justify-center px-2" : "px-3",
                )}
              >
                <ArrowLeft className="h-4 w-4 flex-shrink-0" />
                {!collapsed && <span className="truncate">Back to project</span>}
              </Link>
            )}

            {currentWorkspace && visibleSettingsItems.length > 0 && (
              <>
                {!collapsed && (
                  <div className="px-3 pt-3 pb-1">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Workspace
                    </p>
                    <p className="truncate text-sm font-medium">{currentWorkspace.name}</p>
                  </div>
                )}
                {visibleSettingsItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeSettingsTab === item.tab;
                  return (
                    <Link
                      key={item.tab}
                      href={`/${currentWorkspaceSlug}/settings?tab=${item.tab}`}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        "flex h-9 items-center gap-3 rounded-md text-sm font-medium transition-colors",
                        collapsed ? "justify-center px-2" : "px-3",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      {!collapsed && item.label}
                    </Link>
                  );
                })}
              </>
            )}

            {!collapsed && (
              <div className="px-3 pt-4 pb-1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Account
                </p>
              </div>
            )}
            {(() => {
              const active = pathname === "/settings/account";
              return (
                <Link
                  href="/settings/account"
                  title={collapsed ? "Account settings" : undefined}
                  className={cn(
                    "flex h-9 items-center gap-3 rounded-md text-sm font-medium transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <User className="h-4 w-4 flex-shrink-0" />
                  {!collapsed && "Account settings"}
                </Link>
              );
            })()}
          </>
        ) : (
          <>
            {analyticsNavItems.map((item) => {
              const Icon = item.icon;
              const href = `${basePath}/${item.path}`;
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={item.path}
                  href={href}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex h-9 items-center gap-3 rounded-md text-sm font-medium transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  {!collapsed && item.label}
                  {!collapsed && item.comingSoon && (
                    <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                      Soon
                    </span>
                  )}
                </Link>
              );
            })}
            {currentWorkspaceSlug && (
              <Link
                href={`/${currentWorkspaceSlug}/settings`}
                title={collapsed ? "Settings" : undefined}
                className={cn(
                  "flex h-9 items-center gap-3 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                  collapsed ? "justify-center px-2" : "px-3",
                )}
              >
                <Settings className="h-4 w-4 flex-shrink-0" />
                {!collapsed && "Settings"}
              </Link>
            )}
          </>
        )}
      </nav>

      <Separator />

      <div className="p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={collapsed ? displayName : undefined}
              className={cn(
                "flex h-10 w-full items-center gap-2 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                collapsed ? "justify-center px-2" : "px-2",
              )}
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background">
                {initial}
              </span>
              {!collapsed && <span className="truncate">{displayName}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <span className="block truncate text-sm font-medium">{displayName}</span>
              <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/account">
                <User className="h-4 w-4" />
                Account settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut({ callbackUrl: "/login" })}>
              <LogOut className="h-4 w-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
