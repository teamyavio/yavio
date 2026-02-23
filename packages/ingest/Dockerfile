FROM node:22-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/ingest/package.json packages/ingest/
RUN pnpm install --frozen-lockfile --filter @yavio/ingest...

FROM base AS build
WORKDIR /app
COPY --from=deps /app .
COPY . .
RUN pnpm turbo build --filter=@yavio/ingest...
RUN pnpm deploy --filter @yavio/ingest --prod /app/deploy

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 ingest

COPY --from=build --chown=ingest:nodejs /app/deploy .

USER ingest

EXPOSE 3001
CMD ["node", "dist/server.js"]
