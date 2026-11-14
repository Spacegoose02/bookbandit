import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { authPlugin } from "./auth/plugin.js";
import { parseTrustedProxies } from "./auth/trusted-proxy.js";
import { healthRoutes } from "./routes/health.js";
import { bookRoutes } from "./routes/books.js";
import { integrationsPlugin, type IntegrationsOptions } from "./integrations/index.js";

/** Test seams for outside services. */
export interface AppDeps {
  integrations?: Pick<IntegrationsOptions, "secretKey" | "fetchImpl" | "makeMailer">;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  await app.register(authPlugin, {
    db,
    emailHeader: config.AUTH_HEADER_EMAIL,
    trustedProxies: parseTrustedProxies(config.TRUSTED_PROXIES),
  });
  await app.register(healthRoutes);
  await app.register(bookRoutes, { db });
  await app.register(integrationsPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    booksDir: config.BOOKS_DIR,
    ...deps.integrations,
  });

  return app;
}
