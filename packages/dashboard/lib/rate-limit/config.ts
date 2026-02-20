import type { RateLimitConfig } from "./rate-limiter";

export const rateLimitConfigs = {
  authLogin: { ratePerSecond: 10 / 60, burstCapacity: 10 } satisfies RateLimitConfig,
  authOther: { ratePerSecond: 30 / 60, burstCapacity: 30 } satisfies RateLimitConfig,
  analytics: { ratePerSecond: 60 / 60, burstCapacity: 60 } satisfies RateLimitConfig,
  management: { ratePerSecond: 30 / 60, burstCapacity: 30 } satisfies RateLimitConfig,
  health: { ratePerSecond: 60 / 60, burstCapacity: 60 } satisfies RateLimitConfig,
};

export type RateLimitGroup = keyof typeof rateLimitConfigs;
