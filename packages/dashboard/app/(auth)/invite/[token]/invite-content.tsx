"use client";

import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface InviteInfo {
  email: string;
  role: string;
  workspace: { id: string; name: string; slug: string };
}

export function InviteContent() {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "accepting" | "accepted" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState("Invalid or expired invitation link.");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      return;
    }

    fetch(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setErrorMessage(data?.error ?? "Invalid or expired invitation link.");
          setStatus("error");
          return;
        }
        const data = await res.json();
        setInvite(data.invitation);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [token]);

  const handleAccept = async () => {
    setStatus("accepting");
    try {
      const res = await fetch(`/api/auth/invite/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      if (res.ok) {
        setStatus("accepted");
      } else {
        const data = await res.json().catch(() => null);
        setErrorMessage(data?.error ?? "Failed to accept invitation.");
        setStatus("error");
      }
    } catch {
      setErrorMessage("Failed to accept invitation.");
      setStatus("error");
    }
  };

  if (status === "loading") {
    return (
      <AuthCard title="Loading invitation..." description="Please wait.">
        <div className="text-center text-sm text-muted-foreground">Loading...</div>
      </AuthCard>
    );
  }

  if (status === "accepted") {
    return (
      <AuthCard
        title="Invitation accepted"
        description="You have joined the workspace successfully."
      >
        <Link href="/">
          <Button className="w-full">Go to dashboard</Button>
        </Link>
      </AuthCard>
    );
  }

  if (status === "error") {
    return (
      <AuthCard title="Invitation error" description={errorMessage}>
        <Link href="/login">
          <Button variant="outline" className="w-full">
            Back to login
          </Button>
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Workspace invitation"
      description={`You have been invited to join ${invite?.workspace.name} as ${invite?.role}.`}
    >
      <div className="space-y-4">
        <div className="text-center text-sm text-muted-foreground">
          Invitation for {invite?.email}
        </div>
        <Button className="w-full" onClick={handleAccept} disabled={status === "accepting"}>
          {status === "accepting" ? "Accepting..." : "Accept invitation"}
        </Button>
        <Link href="/login">
          <Button variant="outline" className="w-full">
            Decline
          </Button>
        </Link>
      </div>
    </AuthCard>
  );
}
