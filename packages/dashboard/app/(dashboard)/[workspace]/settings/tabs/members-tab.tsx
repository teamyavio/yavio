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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WorkspaceRole } from "@yavio/shared/validation";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

interface MembersTabProps {
  workspaceId: string;
  userRole: WorkspaceRole;
  userId: string;
}

interface Member {
  id: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  createdAt: string;
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Request failed");
    return r.json();
  });

const ASSIGNABLE_ROLES: { value: WorkspaceRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

export function MembersTab({ workspaceId, userRole, userId }: MembersTabProps) {
  const {
    data: membersData,
    isLoading: membersLoading,
    mutate: mutateMembers,
  } = useSWR<{ members: Member[] }>(`/api/workspaces/${workspaceId}/members`, fetcher);
  const {
    data: invitationsData,
    isLoading: invitationsLoading,
    mutate: mutateInvitations,
  } = useSWR<{ invitations: Invitation[] }>(`/api/workspaces/${workspaceId}/invitations`, fetcher);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [roleTarget, setRoleTarget] = useState<Member | null>(null);
  const [newRole, setNewRole] = useState<WorkspaceRole>("member");

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");

  async function handleInvite() {
    setInviteLoading(true);
    setInviteError("");
    const res = await fetch(`/api/workspaces/${workspaceId}/members/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });

    if (!res.ok) {
      const body = await res.json();
      setInviteError(body.error ?? "Failed to send invitation");
      setInviteLoading(false);
      return;
    }

    toast.success(`Invitation sent to ${inviteEmail}`);
    setInviteEmail("");
    setInviteRole("member");
    setInviteOpen(false);
    setInviteLoading(false);
    mutateInvitations();
  }

  async function handleRoleChange() {
    if (!roleTarget) return;
    const res = await fetch(`/api/workspaces/${workspaceId}/members/${roleTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });

    if (!res.ok) {
      const body = await res.json();
      toast.error(body.error ?? "Failed to update role");
      setRoleTarget(null);
      return;
    }

    toast.success(`Role updated to ${newRole}`);
    setRoleTarget(null);
    mutateMembers();
  }

  async function handleRemove() {
    if (!removeTarget) return;
    const res = await fetch(`/api/workspaces/${workspaceId}/members/${removeTarget.id}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const body = await res.json();
      toast.error(body.error ?? "Failed to remove member");
      setRemoveTarget(null);
      return;
    }

    toast.success("Member removed");
    setRemoveTarget(null);
    mutateMembers();
  }

  async function handleCancelInvitation(invitationId: string) {
    const res = await fetch(`/api/workspaces/${workspaceId}/invitations/${invitationId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const body = await res.json();
      toast.error(body.error ?? "Failed to cancel invitation");
      return;
    }

    toast.success("Invitation cancelled");
    mutateInvitations();
  }

  const isAdmin = userRole === "owner" || userRole === "admin";
  const members = membersData?.members ?? [];
  const invitations = invitationsData?.invitations ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Members</CardTitle>
            <CardDescription>Manage who has access to this workspace.</CardDescription>
          </div>
          {isAdmin && (
            <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="mr-1 h-4 w-4" />
                  Invite
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Invite Member</DialogTitle>
                  <DialogDescription>Send an invitation to join this workspace.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  {inviteError && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                      {inviteError}
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">Email</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      placeholder="colleague@example.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-role">Role</Label>
                    <Select
                      value={inviteRole}
                      onValueChange={(v) => setInviteRole(v as WorkspaceRole)}
                    >
                      <SelectTrigger id="invite-role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ROLES.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={handleInvite} disabled={!inviteEmail || inviteLoading}>
                    {inviteLoading ? "Sending..." : "Send Invitation"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </CardHeader>
        <CardContent>
          {membersLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  {isAdmin && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const isSelf = member.id === userId;
                  const isOwnerMember = member.role === "owner";
                  const canManage = isAdmin && !isSelf && !isOwnerMember;

                  return (
                    <TableRow key={member.id}>
                      <TableCell>
                        {member.name ?? "—"}
                        {isSelf && (
                          <span className="text-muted-foreground ml-1 text-xs">(you)</span>
                        )}
                      </TableCell>
                      <TableCell>{member.email}</TableCell>
                      <TableCell>
                        <Badge variant={isOwnerMember ? "default" : "secondary"}>
                          {member.role}
                        </Badge>
                      </TableCell>
                      <TableCell>{new Date(member.joinedAt).toLocaleDateString()}</TableCell>
                      {isAdmin && (
                        <TableCell>
                          {canManage && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRoleTarget(member);
                                    setNewRole(member.role);
                                  }}
                                >
                                  Change role
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => setRemoveTarget(member)}
                                >
                                  Remove
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Change role dialog */}
      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoleTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Role</DialogTitle>
            <DialogDescription>
              Update the role for {roleTarget?.name ?? roleTarget?.email}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-role">Role</Label>
            <Select value={newRole} onValueChange={(v) => setNewRole(v as WorkspaceRole)}>
              <SelectTrigger id="new-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleRoleChange}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove member confirmation */}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove Member"
        description={`Are you sure you want to remove ${removeTarget?.name ?? removeTarget?.email} from this workspace?`}
        actionLabel="Remove"
        onConfirm={handleRemove}
      />

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <>
          <Separator />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pending Invitations</CardTitle>
            </CardHeader>
            <CardContent>
              {invitationsLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell>{inv.email}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{inv.role}</Badge>
                        </TableCell>
                        <TableCell>{new Date(inv.expiresAt).toLocaleDateString()}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => handleCancelInvitation(inv.id)}
                          >
                            Cancel
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
