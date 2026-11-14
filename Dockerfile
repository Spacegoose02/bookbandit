# Bookbandit: single container (API + web app). Volumes: /config, /books.
# TODO(docker workstream): serve the web build from the server, add ebook-convert
# (Calibre CLI) and kepubify, multi-arch build, PUID/PGID for Unraid.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production CONFIG_DIR=/config BOOKS_DIR=/books PORT=8080
RUN corepack enable
COPY --from=build /app /app
VOLUME ["/config", "/books"]
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
