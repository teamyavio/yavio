import { getDb } from "@/lib/db";
import { loginAttempts } from "@yavio/db/schema";
import { and, eq, gt } from "drizzle-orm";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const THRESHOLDS = [
  { attempts: 50, lockMinutes: 60 },
  { attempts: 25, lockMinutes: 15 },
  { attempts: 10, lockMinutes: 5 },
];

export interface LockoutResult {
  locked: boolean;
  lockMinutes?: number;
  attempts: number;
}

export async function checkLockout(email: string): Promise<LockoutResult> {
  const db = getDb();
  const windowStart = new Date(Date.now() - WINDOW_MS);

  const rows = await db
    .select()
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), gt(loginAttempts.attemptedAt, windowStart)));

  const count = rows.length;

  for (const threshold of THRESHOLDS) {
    if (count >= threshold.attempts) {
      return { locked: true, lockMinutes: threshold.lockMinutes, attempts: count };
    }
  }

  return { locked: false, attempts: count };
}

export async function recordFailedAttempt(email: string, ipAddress: string): Promise<void> {
  const db = getDb();
  await db.insert(loginAttempts).values({ email, ipAddress });
}
