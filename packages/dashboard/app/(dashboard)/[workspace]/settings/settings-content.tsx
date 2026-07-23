"use client";

import { ROLE_LEVEL, resolveWorkspaceTab } from "@/lib/settings-nav";
import type { WorkspaceRole } from "@yavio/shared/validation";
import { useSearchParams } from "next/navigation";
import { ApiKeysTab } from "./tabs/api-keys-tab";
import { BillingTab } from "./tabs/billing-tab";
import { GeneralTab } from "./tabs/general-tab";
import { MembersTab } from "./tabs/members-tab";
import { ProjectsTab } from "./tabs/projects-tab";

interface WorkspaceSettingsContentProps {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  userRole: WorkspaceRole;
  isOwner: boolean;
  userId: string;
}

export function WorkspaceSettingsContent({
  workspaceId,
  workspaceSlug,
  workspaceName,
  userRole,
  isOwner,
  userId,
}: WorkspaceSettingsContentProps) {
  const searchParams = useSearchParams();

  const isAdmin = ROLE_LEVEL[userRole] >= ROLE_LEVEL.admin;
  const isMember = ROLE_LEVEL[userRole] >= ROLE_LEVEL.member;

  // Unknown or role-forbidden ?tab= values fall back to the first tab
  // this role may see instead of rendering an empty page.
  const activeTab = resolveWorkspaceTab(searchParams.get("tab"), userRole);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Workspace settings</h1>
        <p className="text-muted-foreground text-sm">{workspaceName}</p>
      </div>
      {activeTab === "general" && isAdmin && (
        <GeneralTab
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaceSlug={workspaceSlug}
          isOwner={isOwner}
        />
      )}
      {activeTab === "members" && isAdmin && (
        <MembersTab workspaceId={workspaceId} userRole={userRole} userId={userId} />
      )}
      {activeTab === "projects" && isMember && (
        <ProjectsTab workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
      )}
      {activeTab === "api-keys" && isMember && <ApiKeysTab workspaceId={workspaceId} />}
      {activeTab === "billing" && <BillingTab />}
    </div>
  );
}
