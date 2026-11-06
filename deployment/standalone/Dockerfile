FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/api/package.json ./apps/api/package.json
COPY apps/app/package.json ./apps/app/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @findme/api build
RUN VITE_CORE_API_BASE= pnpm --filter @findme/app build
RUN pnpm --filter @findme/api deploy --prod /runtime
RUN cp -r apps/api/dist /runtime/dist

FROM node:24-bookworm-slim
ARG FINDME_VERSION=unknown
LABEL org.opencontainers.image.revision=$FINDME_VERSION
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
COPY --from=build /runtime/ ./
COPY --from=build /src/apps/app/dist ./public
COPY --from=build /src/apps/api/resources ./resources
COPY packages/db/schema.sql ./packages/db/schema.sql
COPY packages/db/access ./packages/db/access
COPY packages/db/migrations ./packages/db/migrations
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
