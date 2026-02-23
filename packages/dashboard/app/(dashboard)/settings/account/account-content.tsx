"use client";

import { DangerZone } from "@/components/settings/danger-zone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  type ChangePasswordInput,
  type UpdateProfileInput,
  changePasswordSchema,
  updateProfileSchema,
} from "@/lib/account/validation";
import { zodResolver } from "@hookform/resolvers/zod";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

interface AccountSettingsContentProps {
  userId: string;
  name: string | null;
  email: string;
  hasPassword: boolean;
}

export function AccountSettingsContent({ name, email, hasPassword }: AccountSettingsContentProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Profile form
  const {
    register: registerProfile,
    handleSubmit: handleProfileSubmit,
    formState: { errors: profileErrors, isSubmitting: profileSubmitting },
  } = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { name: name ?? "" },
  });

  // Password form
  const {
    register: registerPassword,
    handleSubmit: handlePasswordSubmit,
    formState: { errors: passwordErrors, isSubmitting: passwordSubmitting },
    reset: resetPassword,
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
  });

  const [profileError, setProfileError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  async function onProfileSubmit(data: UpdateProfileInput) {
    setProfileError("");
    const res = await fetch("/api/auth/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const body = await res.json();
      setProfileError(body.error ?? "Failed to update profile");
      return;
    }

    toast.success("Profile updated");
  }

  async function onPasswordSubmit(data: ChangePasswordInput) {
    setPasswordError("");
    const res = await fetch("/api/auth/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const body = await res.json();
      setPasswordError(body.error ?? "Failed to change password");
      return;
    }

    toast.success("Password changed");
    resetPassword();
  }

  async function handleDeleteAccount() {
    setDeleteError("");
    setDeleteLoading(true);
    try {
      const res = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          hasPassword ? { password: deletePassword } : { confirmEmail: deleteConfirmEmail },
        ),
      });

      if (!res.ok) {
        const body = await res.json();
        setDeleteError(body.error ?? "Failed to delete account");
        return;
      }

      toast.success("Account deleted");
      await signOut({ callbackUrl: "/login" });
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Account Settings</h1>
        <p className="text-muted-foreground text-sm">Manage your profile and security.</p>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Update your display name.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleProfileSubmit(onProfileSubmit)} className="space-y-4">
            {profileError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {profileError}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input id="profile-name" {...registerProfile("name")} />
              {profileErrors.name && (
                <p className="text-sm text-destructive">{profileErrors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input id="profile-email" value={email} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">Email cannot be changed.</p>
            </div>
            <Button type="submit" disabled={profileSubmitting}>
              {profileSubmitting ? "Saving..." : "Save"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>Update your password for email-based login.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSubmit(onPasswordSubmit)} className="space-y-4">
            {passwordError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {passwordError}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="current-pw">Current Password</Label>
              <Input id="current-pw" type="password" {...registerPassword("currentPassword")} />
              {passwordErrors.currentPassword && (
                <p className="text-sm text-destructive">{passwordErrors.currentPassword.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-pw">New Password</Label>
              <Input id="new-pw" type="password" {...registerPassword("newPassword")} />
              {passwordErrors.newPassword && (
                <p className="text-sm text-destructive">{passwordErrors.newPassword.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-pw">Confirm New Password</Label>
              <Input id="confirm-pw" type="password" {...registerPassword("confirmNewPassword")} />
              {passwordErrors.confirmNewPassword && (
                <p className="text-sm text-destructive">
                  {passwordErrors.confirmNewPassword.message}
                </p>
              )}
            </div>
            <Button type="submit" disabled={passwordSubmitting}>
              {passwordSubmitting ? "Changing..." : "Change Password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Separator />

      {/* Danger Zone */}
      <DangerZone description="Permanently delete your account and all owned workspaces. This action cannot be undone.">
        <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
          Delete Account
        </Button>
        <AlertDialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteOpen(false);
              setDeletePassword("");
              setDeleteConfirmEmail("");
              setDeleteError("");
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Account</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete your account, all owned workspaces, and associated
                data.{" "}
                {hasPassword
                  ? "Enter your password to confirm."
                  : "Enter your email address to confirm."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              {deleteError && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {deleteError}
                </div>
              )}
              {hasPassword ? (
                <>
                  <Label htmlFor="delete-pw">Password</Label>
                  <Input
                    id="delete-pw"
                    type="password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <Label htmlFor="delete-email">Email Address</Label>
                  <Input
                    id="delete-email"
                    type="email"
                    placeholder={email}
                    value={deleteConfirmEmail}
                    onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                  />
                </>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={
                  deleteLoading || (hasPassword ? !deletePassword : deleteConfirmEmail !== email)
                }
                onClick={(e) => {
                  e.preventDefault();
                  handleDeleteAccount();
                }}
              >
                {deleteLoading ? "Deleting..." : "Delete Account"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DangerZone>
    </div>
  );
}
