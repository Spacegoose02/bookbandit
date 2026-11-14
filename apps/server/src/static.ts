/**
 * Serves the built web app (apps/web/dist) from the API server, so the Docker image is one
 * process on one port. Owned by the Docker workstream.
 *
 * - Real files (JS, CSS, images) are served as-is; hashed files under /assets/ are cached forever.
 * - Any other GET that is not /api/** and looks like a page gets index.html (client-side routing).
 * - /api/** never falls back to index.html, so unknown API routes stay JSON 404s.
 */
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface StaticOptions {
  /** Directory holding index.html and assets/. Missing or empty = API only. */
  webDir: string;
}

/** apps/web/dist, found relative to this file (works from src/ under tsx and from dist/). */
export function defaultWebDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

export async function staticRoutes(app: FastifyInstance, opts: StaticOptions) {
  const root = resolve(opts.webDir);
  if (!existsSync(join(root, "index.html"))) {
    app.log.warn({ webDir: root }, "web build not found; serving the API only");
    return;
  }

  const assetsDir = join(root, "assets") + sep;
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    // We set cache-control ourselves in setHeaders (send would add "public, max-age=0").
    cacheControl: false,
    index: ["index.html"],
    setHeaders(res, path) {
      if (path.startsWith(assetsDir)) {
        res.header("cache-control", "public, max-age=31536000, immutable");
      } else {
        res.header("cache-control", "no-cache");
      }
    },
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const wantsPage =
      (req.method === "GET" || req.method === "HEAD") &&
      !path.startsWith("/api/") &&
      path !== "/api" &&
      !/\.[a-z0-9]+$/i.test(path);
    if (wantsPage) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found", message: `Route ${req.method}:${path} not found`, statusCode: 404 });
  });
}
