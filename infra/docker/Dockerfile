# syntax=docker/dockerfile:1.7
# Hotella application images (ADR-0013). Build context: repository root.
#   docker build -f infra/docker/Dockerfile --target api    -t hotella/api:<version>    .
#   docker build -f infra/docker/Dockerfile --target worker -t hotella/worker:<version> .
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
# Manifests first so dependency installation is cached independently of source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY tooling ./tooling
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages ./packages
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@hotella/api... --filter=@hotella/worker...
# Self-contained production bundles: dist + production dependencies, workspace packages copied in.
RUN pnpm --filter @hotella/api deploy --prod --legacy /out/api \
 && pnpm --filter @hotella/worker deploy --prod --legacy /out/worker \
 && cp -r locales /out/api/locales && cp -r locales /out/worker/locales

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production LOCALES_DIR=/app/locales
WORKDIR /app
# Never run as root; the image contains no build tooling and no source maps of secrets.
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
