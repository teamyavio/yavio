import type { Database } from "@yavio/db/client";
import {
  apiKeys,
  invitations,
  loginAttempts,
  sessions,
  stripeWebhookEvents,
  verificationTokens,
} from "@yavio/db/schema";
import { and, isNotNull, lt, or, sql } from "drizzle-orm";
import { pruneExpired } from "../oauth/store";

/** Advisory-lock key (stats job 8_502_311_985, erasure worker 8_502_311_986). */
export const HOUSEKEEPING_LOCK_KEY = 8_502_311_987;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Rows deleted per table in one run. */
export type HousekeepingReport = Record<string, number>;

interface HousekeepingOptions {
  db: Database;
  logger?: Pick<Console, "info" | "error">;
  /** Default 1 h. */
  intervalMs?: number;
}

/**
 * Postgres housekeeping (#92; .specs/infrastructure/storage-layer.md §5.3.2).
 * Hourly, under an advisory lock so one dashboard instance runs it:
 *
 * - login_attempts older than 24 h — email and IP; the lockout window is 15 min;
 * - sessions past their expiry;
 * - verification tokens used or past expiry (both already read as invalid);
 * - invitations a day past expiry, accepted or not (nothing reads accepted ones);
 * - API keys revoked more than a year ago (kept that long for the audit trail);
 * - processed Stripe webhook ids after 30 days (idempotency records only);
 * - expired OAuth codes, tokens and unused client registrations (pruneExpired,
 *   which the token endpoint also runs opportunistically).
 *
 * The periods are documented for customers in the docs' data-retention page.
 */
export class HousekeepingJob {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HousekeepingOptions) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      this.runOnce().catch((err) => this.options.logger?.error("[housekeeping] run failed", err));
    };
    this.timer = setInterval(tick, this.options.intervalMs ?? HOUR);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One run; null when another instance holds the lock. */
  async runOnce(now: Date = new Date()): Promise<HousekeepingReport | null> {
    const report = await this.options.db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${HOUSEKEEPING_LOCK_KEY}) AS locked`,
      );
      if (!lock?.locked) return null;

      const count = async (q: Promise<unknown[]>) => (await q).length;
      return {
        login_attempts: await count(
          tx
            .delete(loginAttempts)
            .where(lt(loginAttempts.attemptedAt, new Date(now.getTime() - DAY)))
            .returning({ id: loginAttempts.id }),
        ),
        sessions: await count(
          tx.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id }),
        ),
        verification_tokens: await count(
          tx
            .delete(verificationTokens)
            .where(or(lt(verificationTokens.expiresAt, now), isNotNull(verificationTokens.usedAt)))
            .returning({ id: verificationTokens.id }),
        ),
        invitations: await count(
          tx
            .delete(invitations)
            .where(lt(invitations.expiresAt, new Date(now.getTime() - DAY)))
            .returning({ id: invitations.id }),
        ),
        api_keys: await count(
          tx
            .delete(apiKeys)
            .where(
              and(
                isNotNull(apiKeys.revokedAt),
                lt(apiKeys.revokedAt, new Date(now.getTime() - 365 * DAY)),
              ),
            )
            .returning({ id: apiKeys.id }),
        ),
        stripe_webhook_events: await count(
          tx
            .delete(stripeWebhookEvents)
            .where(lt(stripeWebhookEvents.processedAt, new Date(now.getTime() - 30 * DAY)))
            .returning({ id: stripeWebhookEvents.eventId }),
        ),
      } satisfies HousekeepingReport;
    });
    if (report === null) return null;
    // Its own statements; it reads the clock from Postgres.
    await pruneExpired(this.options.db);
    if (Object.values(report).some((n) => n > 0)) {
      this.options.logger?.info("[housekeeping] deleted", report);
    }
    return report;
  }
}
