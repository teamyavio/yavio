import {
  CreditCard,
  FolderKanban,
  KeyRound,
  LockKeyhole,
  SlidersHorizontal,
  User,
  Users,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

/**
 * Single source of truth for the settings navigation: which tabs exist,
 * who may see them, and how an untrusted ?tab= query value resolves.
 * Both the sidebar and the settings pages derive from this so they can
 * never disagree about visibility or the default tab.
 */

export const ROLE_LEVEL: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export interface SettingsTab {
  tab: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  minRole: number;
}

export const workspaceSettingsTabs: SettingsTab[] = [
  { tab: "general", label: "General", icon: SlidersHorizontal, minRole: ROLE_LEVEL.admin },
  { tab: "members", label: "Members", icon: Users, minRole: ROLE_LEVEL.admin },
  { tab: "projects", label: "Projects", icon: FolderKanban, minRole: ROLE_LEVEL.member },
  { tab: "api-keys", label: "API Keys", icon: KeyRound, minRole: ROLE_LEVEL.member },
  { tab: "billing", label: "Billing", icon: CreditCard, minRole: ROLE_LEVEL.viewer },
];

export const accountSettingsTabs: SettingsTab[] = [
  { tab: "profile", label: "Profile", icon: User, minRole: ROLE_LEVEL.viewer },
  { tab: "security", label: "Security", icon: LockKeyhole, minRole: ROLE_LEVEL.viewer },
];

export function visibleWorkspaceTabs(role: string): SettingsTab[] {
  const level = ROLE_LEVEL[role] ?? 0;
  return workspaceSettingsTabs.filter((t) => level >= t.minRole);
}

/**
 * Resolve an untrusted ?tab= value to a tab this role may actually see,
 * falling back to the role's first visible tab.
 */
export function resolveWorkspaceTab(tabParam: string | null, role: string): string | undefined {
  const visible = visibleWorkspaceTabs(role);
  return visible.some((t) => t.tab === tabParam) && tabParam !== null ? tabParam : visible[0]?.tab;
}

export function resolveAccountTab(tabParam: string | null): string {
  return accountSettingsTabs.some((t) => t.tab === tabParam) && tabParam !== null
    ? tabParam
    : "profile";
}
