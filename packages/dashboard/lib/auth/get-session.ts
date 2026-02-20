import { auth } from "@/lib/auth";

export interface AppSession {
  userId: string;
  email: string;
  name: string | null;
}

export async function getServerSession(): Promise<AppSession | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
  };
}
