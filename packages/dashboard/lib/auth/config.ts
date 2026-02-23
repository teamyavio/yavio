import { getDb } from "@/lib/db";
import { projects, users, workspaceMembers, workspaces } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { checkLockout, recordFailedAttempt } from "./account-lockout";
import { YavioAdapter } from "./adapter";
import { verifyPassword } from "./password";

function getLazyAdapter() {
  let adapter: ReturnType<typeof YavioAdapter> | null = null;
  return new Proxy({} as ReturnType<typeof YavioAdapter>, {
    get(_target, prop) {
      if (!adapter) {
        adapter = YavioAdapter(getDb());
      }
      return (adapter as Record<string | symbol, unknown>)[prop];
    },
  });
}

export const authConfig: NextAuthConfig = {
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
  adapter: getLazyAdapter(),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    ...(process.env.GITHUB_CLIENT_ID
      ? [
          GitHub({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: (() => {
              const secret = process.env.GITHUB_CLIENT_SECRET;
              if (!secret)
                throw new Error(
                  "GITHUB_CLIENT_SECRET must be set when GITHUB_CLIENT_ID is configured",
                );
              return secret;
            })(),
          }),
        ]
      : []),
    ...(process.env.GOOGLE_CLIENT_ID
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: (() => {
              const secret = process.env.GOOGLE_CLIENT_SECRET;
              if (!secret)
                throw new Error(
                  "GOOGLE_CLIENT_SECRET must be set when GOOGLE_CLIENT_ID is configured",
                );
              return secret;
            })(),
          }),
        ]
      : []),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        // Check account lockout before attempting authentication
        const lockout = await checkLockout(email);
        if (lockout.locked) return null;

        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

        const db = getDb();
        const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
        const user = rows[0];
        if (!user?.passwordHash) {
          await recordFailedAttempt(email, ip);
          return null;
        }

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) {
          await recordFailedAttempt(email, ip);
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatarUrl,
        };
      },
    }),
  ],
  events: {
    async createUser({ user }) {
      // On first OAuth login, create default workspace
      if (user.id && user.email) {
        const db = getDb();
        const slug = user.email
          .split("@")[0]
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .slice(0, 40);
        const workspaceName = `${user.name ?? "My"}'s Workspace`;

        try {
          const [ws] = await db
            .insert(workspaces)
            .values({
              name: workspaceName,
              slug: `${slug}-${user.id.slice(0, 8)}`,
              ownerId: user.id,
            })
            .returning({ id: workspaces.id });

          await db.insert(workspaceMembers).values({
            workspaceId: ws.id,
            userId: user.id,
            role: "owner",
          });

          await db.insert(projects).values({
            workspaceId: ws.id,
            name: "Default Project",
            slug: "default",
          });
        } catch {
          console.error("Failed to create default workspace for OAuth user");
        }
      }
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
};
