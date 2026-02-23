"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WorkspaceRole } from "@yavio/shared/validation";
import { useRouter, useSearchParams } from "next/navigation";
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
  const router = useRouter();

  const isAdmin = ROLE_LEVEL[userRole] >= ROLE_LEVEL.admin;
  const isMember = ROLE_LEVEL[userRole] >= ROLE_LEVEL.member;

  const defaultTab = isAdmin ? "general" : isMember ? "projects" : "billing";
  const activeTab = searchParams.get("tab") ?? defaultTab;

  function setTab(tab: string) {
    router.replace(`/${workspaceSlug}/settings?tab=${tab}`, {
      scroll: false,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Workspace Settings</h1>
        <p className="text-muted-foreground text-sm">{workspaceName}</p>
      </div>
      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          {isAdmin && <TabsTrigger value="general">General</TabsTrigger>}
          {isAdmin && <TabsTrigger value="members">Members</TabsTrigger>}
          {isMember && <TabsTrigger value="projects">Projects</TabsTrigger>}
          {isMember && <TabsTrigger value="api-keys">API Keys</TabsTrigger>}
          <TabsTrigger value="billing">Billing</TabsTrigger>
        </TabsList>

        {isAdmin && (
          <TabsContent value="general">
            <GeneralTab
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              workspaceSlug={workspaceSlug}
              isOwner={isOwner}
            />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="members">
            <MembersTab workspaceId={workspaceId} userRole={userRole} userId={userId} />
          </TabsContent>
        )}
        {isMember && (
          <TabsContent value="projects">
            <ProjectsTab workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
          </TabsContent>
        )}
        {isMember && (
          <TabsContent value="api-keys">
            <ApiKeysTab workspaceId={workspaceId} />
          </TabsContent>
        )}
        <TabsContent value="billing">
          <BillingTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
