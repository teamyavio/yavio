import { getServerSession } from "@/lib/auth/get-session";
import { getDb } from "@/lib/db";
import { users } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AccountSettingsContent } from "./account-content";

export default async function AccountSettingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // Read directly from DB so updates are visible immediately on refresh
  const db = getDb();
  const [user] = await db
    .select({ name: users.name, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) redirect("/login");

  return (
    <Suspense fallback={<div className="animate-pulse space-y-4" />}>
      <AccountSettingsContent
        userId={session.userId}
        name={user.name}
        email={user.email}
        hasPassword={user.passwordHash !== null}
      />
    </Suspense>
  );
}
