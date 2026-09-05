# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/pi-plugin/package.json packages/pi-plugin/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @pi-kanban/web build \
 && pnpm --filter @pi-kanban/server build

# Prod-only node_modules with the same workspace layout as the final stage.
FROM node:22-alpine AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/pi-plugin/package.json packages/pi-plugin/
RUN pnpm install --frozen-lockfile --prod --filter @pi-kanban/server

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps /repo/packages/shared/package.json ./packages/shared/package.json
# @pi-kanban/shared ships TypeScript source (main: src/index.ts); the compiled
# server resolves it via Node type stripping — keep node:22-alpine >= 22.18.
COPY --from=build /repo/packages/shared/src ./packages/shared/src
COPY apps/server/package.json apps/server/package.json
COPY --from=build /repo/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist
EXPOSE 8787
USER node
CMD ["node", "apps/server/dist/index.js"]
