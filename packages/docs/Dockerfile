FROM node:22-alpine AS base

# ── Install dependencies ──────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/docs/package.json packages/docs/source.config.ts ./packages/docs/
COPY packages/shared/package.json ./packages/shared/

RUN corepack enable pnpm && pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/docs/node_modules ./packages/docs/node_modules
COPY . .

RUN corepack enable pnpm && pnpm --filter @yavio/docs build

# ── Runner ────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/packages/docs/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/packages/docs/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/docs/.next/static ./packages/docs/.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "packages/docs/server.js"]
