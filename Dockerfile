# syntax=docker/dockerfile:1.7
#
# Bookbandit: one container with the API, the web app, Calibre's ebook-convert and kepubify.
# Volumes: /config (database, covers, caches) and /books (your library, plain files).
# Env: PUID/PGID/UMASK (file ownership, Unraid uses 99/100), plus the app settings in
# apps/server/src/config.ts. See docker/README.md.

ARG NODE_VERSION=22
ARG DEBIAN_RELEASE=bookworm

# ---------------------------------------------------------------------------------------------
# 1. Build the TypeScript and the web app once, on the build machine's own CPU (no emulation).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @bookbandit/shared build \
 && pnpm --filter @bookbandit/server build \
 && pnpm --filter @bookbandit/web build

# ---------------------------------------------------------------------------------------------
# 2. Production node_modules for the target CPU (better-sqlite3 is a native module).
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS prod-deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN CI=true pnpm install --prod --frozen-lockfile --filter "@bookbandit/server..." \
 && cd apps/server \
 && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get(); console.log('better-sqlite3 ok')"

# ---------------------------------------------------------------------------------------------
# 3. Calibre (for ebook-convert) and kepubify, downloaded for the target CPU.
FROM debian:${DEBIAN_RELEASE}-slim AS tools
ARG TARGETARCH
# "latest" asks calibre-ebook.com for the current release; pin e.g. --build-arg CALIBRE_VERSION=8.16.2
ARG CALIBRE_VERSION=latest
ARG KEPUBIFY_VERSION=4.0.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) calibre_arch=x86_64; kepub_arch=64bit ;; \
      arm64) calibre_arch=arm64;  kepub_arch=arm64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    version="$CALIBRE_VERSION"; \
    if [ "$version" = "latest" ]; then version="$(curl -fsSL https://code.calibre-ebook.com/latest)"; fi; \
    mkdir -p /opt/calibre; \
    curl -fsSL "https://download.calibre-ebook.com/${version}/calibre-${version}-${calibre_arch}.txz" \
      | tar -xJ -C /opt/calibre; \
    echo "$version" > /opt/calibre/BOOKBANDIT_CALIBRE_VERSION; \
    curl -fsSL -o /usr/local/bin/kepubify \
      "https://github.com/pgaskin/kepubify/releases/download/v${KEPUBIFY_VERSION}/kepubify-linux-${kepub_arch}"; \
    chmod +x /usr/local/bin/kepubify

# ---------------------------------------------------------------------------------------------
# 4. Runtime image.
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Bookbandit" \
      org.opencontainers.image.description="Self-hosted family book library and reader" \
      org.opencontainers.image.source="https://github.com/spacegoose02/bookbandit" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

# Shared libraries Calibre's bundled Qt needs to run headless, plus tini to reap child processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tini xz-utils \
      libegl1 libgl1 libopengl0 libglx0 libxkbcommon0 libxkbfile1 libxcb-cursor0 \
      libnss3 libfontconfig1 libfreetype6 libxcomposite1 libxdamage1 libxrandr2 libxtst6 libxi6 \
      libasound2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY --from=tools /opt/calibre /opt/calibre
COPY --from=tools /usr/local/bin/kepubify /usr/local/bin/kepubify
RUN for b in ebook-convert ebook-meta calibredb; do ln -s /opt/calibre/$b /usr/local/bin/$b; done

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /src/package.json ./
COPY --from=build /src/packages/shared/package.json ./packages/shared/
COPY --from=build /src/packages/shared/dist ./packages/shared/dist
COPY --from=build /src/apps/server/package.json ./apps/server/
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY docker/entrypoint.sh /usr/local/bin/bookbandit-entrypoint

ENV NODE_ENV=production \
    BOOKBANDIT_VERSION=$VERSION \
    CONFIG_DIR=/config \
    BOOKS_DIR=/books \
    WEB_DIR=/app/apps/web/dist \
    PORT=8080 \
    PUID=1000 \
    PGID=1000 \
    UMASK=022 \
    EBOOK_CONVERT_PATH=/opt/calibre/ebook-convert \
    KEPUBIFY_PATH=/usr/local/bin/kepubify \
    QT_QPA_PLATFORM=offscreen \
    CALIBRE_CONFIG_DIRECTORY=/config/calibre \
    CALIBRE_TEMP_DIR=/tmp/calibre \
    HOME=/tmp

# Fail the build if a converter can't start (missing shared library, wrong CPU).
RUN ebook-convert --version && kepubify --version && node -e "process.exit(0)" \
 && chmod +x /usr/local/bin/bookbandit-entrypoint

VOLUME ["/config", "/books"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bookbandit-entrypoint"]
CMD ["node", "apps/server/dist/index.js"]
