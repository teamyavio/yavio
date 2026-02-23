FROM node:22-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @yavio/db...

FROM base AS build
WORKDIR /app
COPY --from=deps /app .
COPY . .
RUN pnpm turbo build --filter=@yavio/db...
RUN pnpm deploy --filter @yavio/db --prod /app/deploy

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/deploy .
CMD ["sh", "-c", "node dist/migrate.js && node dist/migrate-clickhouse.js"]
