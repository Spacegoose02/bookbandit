/**
 * E-reader sync: OPDS catalog (/opds), KOReader progress sync (/kosync), Kobo sync (/kobo),
 * and the API to manage their sign-ins (/api/ereader/credentials). Registered from app.ts.
 */
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { CredentialStore } from "./credentials.js";
import { ereaderCredentialRoutes } from "./routes.js";
import { opdsRoutes } from "../opds/routes.js";
import { koreaderRoutes } from "../koreader/routes.js";
import { koboRoutes } from "../kobo/routes.js";
import { KepubConverter } from "../kobo/kepub.js";

export interface EreaderOptions {
  db: Db;
  config: Config;
  trustedProxies: string[];
  /** Tests: a fake converter instead of running kepubify. */
  kepub?: KepubConverter;
}

export async function ereaderPlugin(app: FastifyInstance, opts: EreaderOptions) {
  const { db, config } = opts;
  const credentials = new CredentialStore(db, opts.trustedProxies);
  const kepub = opts.kepub ?? new KepubConverter(config.KEPUBIFY_PATH, join(config.CONFIG_DIR, "cache"), app.log);
  const paths = { db, booksDir: config.BOOKS_DIR, configDir: config.CONFIG_DIR, credentials };

  await app.register(ereaderCredentialRoutes, { db });
  await app.register(opdsRoutes, paths);
  await app.register(koreaderRoutes, paths);
  await app.register(koboRoutes, { ...paths, kepub });
}
