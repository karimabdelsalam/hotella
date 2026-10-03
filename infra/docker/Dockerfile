# syntax=docker/dockerfile:1.7
# Hotella application images (ADR-0013). Build context: repository root.
#   docker build -f infra/docker/Dockerfile --target api    -t hotella/api:<version>    .
#   docker build -f infra/docker/Dockerfile --target worker -t hotella/worker:<version> .
#   docker build -f infra/docker/Dockerfile --target agent-gateway -t hotella/agent-gateway:<version> .
#   docker build -f infra/docker/Dockerfile --target pms-simulator -t hotella/pms-simulator:<version> .
#   docker build -f infra/docker/Dockerfile --target staff-web -t hotella/staff-web:<version> .
#   docker build -f infra/docker/Dockerfile --target guest-web -t hotella/guest-web:<version> .
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
COPY apps/agent-gateway/package.json apps/agent-gateway/package.json
COPY apps/pms-simulator/package.json apps/pms-simulator/package.json
COPY apps/staff-web/package.json apps/staff-web/package.json
COPY apps/guest-web/package.json apps/guest-web/package.json
COPY packages ./packages
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@hotella/api... --filter=@hotella/worker... \
  --filter=@hotella/agent-gateway... --filter=@hotella/pms-simulator... --filter=@hotella/staff-web... \
  --filter=@hotella/guest-web...
# Self-contained production bundles: dist + production dependencies, workspace packages copied in.
RUN pnpm --filter @hotella/api deploy --prod --legacy /out/api \
 && pnpm --filter @hotella/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @hotella/agent-gateway deploy --prod --legacy /out/agent-gateway \
 && pnpm --filter @hotella/pms-simulator deploy --prod --legacy /out/pms-simulator \
 && pnpm --filter @hotella/staff-web deploy --prod --legacy /out/staff-web \
 && cp -r apps/staff-web/.next /out/staff-web/.next && rm -rf /out/staff-web/.next/cache \
 && pnpm --filter @hotella/guest-web deploy --prod --legacy /out/guest-web \
 && cp -r apps/guest-web/.next /out/guest-web/.next && rm -rf /out/guest-web/.next/cache \
 && for app in api worker agent-gateway; do cp -r locales /out/$app/locales; done

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

FROM runtime AS agent-gateway
COPY --from=build --chown=node:node /out/agent-gateway /app
EXPOSE 8443
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "require('https').get({host:'127.0.0.1',port:process.env.AGENT_GATEWAY_PORT||8443,path:'/agent/v1/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# Development/CI tool: a reference hotel agent with a simulated PMS (BUILD_PLAN §6.3). Never deployed at hotels.
FROM runtime AS pms-simulator
COPY --from=build --chown=node:node /out/pms-simulator /app
ENTRYPOINT ["node", "dist/main.js"]

# Staff web portal (ADR-0009): Next.js server; reaches the API on the internal network (WEB_API_URL).
FROM runtime AS staff-web
COPY --from=build --chown=node:node /out/staff-web /app
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/en/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3100", "--hostname", "0.0.0.0"]

# Guest web app (ADR-0009): the PWA guests open from activation links and room QR codes (PUBLIC_BASE_URL points here).
FROM runtime AS guest-web
COPY --from=build --chown=node:node /out/guest-web /app
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3200
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3200/en').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3200", "--hostname", "0.0.0.0"]
