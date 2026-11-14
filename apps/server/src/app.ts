import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { authPlugin } from "./auth/plugin.js";
import { parseTrustedProxies } from "./auth/trusted-proxy.js";
import { authRoutes } from "./auth/routes.js";
import { loadSessionSecret, SessionSigner } from "./auth/sessions.js";
import { userRoutes } from "./routes/users.js";
import { deviceRoutes } from "./routes/devices.js";
import { healthRoutes } from "./routes/health.js";
import { bookRoutes } from "./routes/books.js";
import { progressRoutes } from "./routes/progress.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { shelfRoutes } from "./routes/shelves.js";
import { homeShelfRoutes } from "./routes/home-shelves.js";
import { defaultWebDir, staticRoutes } from "./static.js";
import { libraryRoutes } from "./library/routes.js";
import { integrationsPlugin, type IntegrationsOptions } from "./integrations/index.js";
import { jobsPlugin } from "./jobs/index.js";
import { requestsPlugin, type RequestsOptions } from "./requests/index.js";

/** Test seams for outside services. */
export interface AppDeps {
  integrations?: Pick<IntegrationsOptions, "secretKey" | "fetchImpl" | "makeMailer">;
  requests?: Pick<RequestsOptions, "fetchImpl" | "pollMs">;
  /** false: tests drive jobs with app.jobs.drain(). */
  jobsAutostart?: boolean;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  const trustedProxies = parseTrustedProxies(config.TRUSTED_PROXIES);
  const sessions = new SessionSigner(loadSessionSecret(db, config.SESSION_SECRET));

  await app.register(authPlugin, { db, emailHeader: config.AUTH_HEADER_EMAIL, trustedProxies, sessions });
  await app.register(authRoutes, { db, sessions, trustedProxies });
  await app.register(userRoutes, { db });
  await app.register(deviceRoutes, { db, trustedProxies });
  await app.register(healthRoutes);
  // Before any plugin that registers job handlers (library, requests).
  await app.register(jobsPlugin, { db, autostart: deps.jobsAutostart });
  await app.register(bookRoutes, { db });
  await app.register(progressRoutes, { db });
  await app.register(bookmarkRoutes, { db });
  await app.register(shelfRoutes, { db });
  await app.register(libraryRoutes, { db, config });
  await app.register(homeShelfRoutes, { db });
  await app.register(integrationsPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    booksDir: config.BOOKS_DIR,
    ...deps.integrations,
  });
  await app.register(requestsPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    booksDir: resolve(config.BOOKS_DIR),
    lookup: config.METADATA_ONLINE
      ? { googleApiKey: config.GOOGLE_BOOKS_API_KEY, hardcoverToken: config.HARDCOVER_API_TOKEN, fetch: deps.requests?.fetchImpl }
      : false,
    secretKey: deps.integrations?.secretKey,
    ...deps.requests,
  });
  // Last: the web app and its index.html fallback for client-side routes.
  await app.register(staticRoutes, { webDir: config.WEB_DIR ?? defaultWebDir() });

  return app;
}
