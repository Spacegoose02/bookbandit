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
import { integrationsPlugin, lazyBox, type IntegrationsOptions } from "./integrations/index.js";
import { loadOrCreateKey } from "./integrations/secrets.js";
import { adminLibraryRoutes } from "./routes/admin-library.js";
import { adminSettingsRoutes, resolveLookup } from "./routes/admin-settings.js";
import { familyRoutes } from "./routes/admin-family.js";
import { discoverPlugin, type DiscoverOptions } from "./discover/index.js";

/** Test seams for outside services. */
export interface AppDeps {
  integrations?: Pick<IntegrationsOptions, "secretKey" | "fetchImpl" | "makeMailer">;
  discover?: Pick<DiscoverOptions, "fetchImpl" | "now">;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  const trustedProxies = parseTrustedProxies(config.TRUSTED_PROXIES);
  const sessions = new SessionSigner(loadSessionSecret(db, config.SESSION_SECRET));

  await app.register(authPlugin, { db, emailHeader: config.AUTH_HEADER_EMAIL, trustedProxies, sessions });
  await app.register(authRoutes, {
    db,
    sessions,
    trustedProxies,
    googleSignInUrl: config.GOOGLE_SIGN_IN_URL,
    emailHeader: config.AUTH_HEADER_EMAIL,
  });
  await app.register(userRoutes, { db });
  await app.register(deviceRoutes, { db, trustedProxies });
  await app.register(healthRoutes);
  await app.register(bookRoutes, { db });
  await app.register(progressRoutes, { db });
  await app.register(bookmarkRoutes, { db });
  await app.register(shelfRoutes, { db });
  // Same key file as the integrations' SecretBox (CONFIG_DIR/secret.key), created on first use.
  const box = lazyBox(() => deps.integrations?.secretKey ?? loadOrCreateKey(config.CONFIG_DIR));
  await app.register(libraryRoutes, { db, config, resolveLookup: () => resolveLookup(db, box, config) });
  await app.register(homeShelfRoutes, { db });
  await app.register(adminLibraryRoutes, { db });
  await app.register(adminSettingsRoutes, { db, box, config });
  await app.register(familyRoutes, { db });
  await app.register(integrationsPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    booksDir: config.BOOKS_DIR,
    ...deps.integrations,
  });
  await app.register(discoverPlugin, {
    db,
    config,
    resolveLookup: () => resolveLookup(db, box, config),
    ...deps.discover,
  });
  // Last: the web app and its index.html fallback for client-side routes.
  await app.register(staticRoutes, { webDir: config.WEB_DIR ?? defaultWebDir() });

  return app;
}
