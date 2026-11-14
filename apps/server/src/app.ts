import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { authPlugin } from "./auth/plugin.js";
import { parseTrustedProxies } from "./auth/trusted-proxy.js";
import { healthRoutes } from "./routes/health.js";
import { bookRoutes } from "./routes/books.js";
import { progressRoutes } from "./routes/progress.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { shelfRoutes } from "./routes/shelves.js";
import { homeShelfRoutes } from "./routes/home-shelves.js";
import { defaultWebDir, staticRoutes } from "./static.js";

export async function buildApp(config: Config, db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  await app.register(authPlugin, {
    db,
    emailHeader: config.AUTH_HEADER_EMAIL,
    trustedProxies: parseTrustedProxies(config.TRUSTED_PROXIES),
  });
  await app.register(healthRoutes);
  await app.register(bookRoutes, { db });
  await app.register(progressRoutes, { db });
  await app.register(bookmarkRoutes, { db });
  await app.register(shelfRoutes, { db });
  await app.register(homeShelfRoutes, { db });
  // Last: the web app and its index.html fallback for client-side routes.
  await app.register(staticRoutes, { webDir: config.WEB_DIR ?? defaultWebDir() });

  return app;
}
