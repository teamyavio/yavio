"use client";

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

const ROLE_LEVEL: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

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

  const defaultTab = isAdmin ? "general" : isMember ? "projects" : "billing";
  const activeTab = searchParams.get("tab") ?? defaultTab;

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
