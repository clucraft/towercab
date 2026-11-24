# syntax=docker/dockerfile:1

# ---- base: Node 24 LTS + pnpm --------------------------------------------------
FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@10.28.1
WORKDIR /repo

# ---- deps: install the whole workspace from the lockfile -------------------------
FROM base AS deps
# Toolchain for native modules (better-sqlite3) on platforms without a prebuilt binary.
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build: web app, then server, then a production-only server tree -----------
FROM deps AS build
COPY . .
RUN pnpm --filter @towercab/web build
RUN pnpm --filter @towercab/server build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @towercab/server deploy --prod --legacy /out

# ---- runtime ---------------------------------------------------------------------
FROM node:26-alpine AS runtime
ARG VERSION=dev
ENV NODE_ENV=production \
    PORT=8790 \
    CONFIG_DIR=/config \
    DATA_DIR=/data \
    TOWERCAB_VERSION=$VERSION

LABEL org.opencontainers.image.title="TowerCab" \
      org.opencontainers.image.description="Live aircraft around an airport in a 3D scene" \
      org.opencontainers.image.source="https://github.com/clucraft/towercab" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=build /out/package.json apps/server/package.json
COPY --from=build /out/node_modules apps/server/node_modules
COPY --from=build /out/dist apps/server/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
COPY config/config.example.yaml config/config.example.yaml

# /config and /data are volumes. They are owned by the default user, and stay usable when the
# container is started with another UID (Unraid runs containers as 99:100).
RUN mkdir -p /config /data && chown node:node /config /data && chmod 0775 /config /data
USER node
VOLUME ["/config", "/data"]
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
