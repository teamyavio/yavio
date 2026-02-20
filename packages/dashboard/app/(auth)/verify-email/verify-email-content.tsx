"use client";

import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      return;
    }

    fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, { method: "POST" })
      .then((res) => {
        setStatus(res.ok ? "success" : "error");
      })
      .catch(() => setStatus("error"));
  }, [token]);

  if (status === "verifying") {
    return (
      <AuthCard title="Verifying..." description="Please wait while we verify your email.">
        <div className="text-center text-sm text-muted-foreground">Loading...</div>
      </AuthCard>
    );
  }

  if (status === "success") {
    return (
      <AuthCard title="Email verified" description="Your email has been verified successfully.">
        <Link href="/login">
          <Button className="w-full">Continue to login</Button>
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Verification failed"
      description="The verification link is invalid or expired."
    >
      <Link href="/login">
        <Button variant="outline" className="w-full">
          Back to login
        </Button>
      </Link>
    </AuthCard>
  );
}
