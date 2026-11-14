/**
 * Integrations: Audiobookshelf (audiobooks + listening progress) and Send to Kindle (SMTP).
 * Registered from app.ts. Each area is its own encapsulated plugin.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { audiobookshelfRoutes } from "./audiobookshelf/routes.js";
import type { FetchLike } from "./audiobookshelf/client.js";
import type { IntegrationsContext } from "./context.js";
import { kindleRoutes } from "./kindle/routes.js";
import { smtpMailer } from "./kindle/mailer.js";
import { loadOrCreateKey, secretBox, type SecretBox } from "./secrets.js";

export interface IntegrationsOptions {
  db: Db;
  configDir: string;
  booksDir: string;
  /** Tests: fixed key instead of CONFIG_DIR/secret.key. */
  secretKey?: Buffer;
  fetchImpl?: FetchLike;
  makeMailer?: IntegrationsContext["makeMailer"];
}

export async function integrationsPlugin(app: FastifyInstance, opts: IntegrationsOptions) {
  const ctx: IntegrationsContext = {
    db: opts.db,
    box: lazyBox(() => opts.secretKey ?? loadOrCreateKey(opts.configDir)),
    booksDir: opts.booksDir,
    fetchImpl: opts.fetchImpl ?? fetch,
    makeMailer: opts.makeMailer ?? smtpMailer,
  };
  await app.register(audiobookshelfRoutes, ctx);
  await app.register(kindleRoutes, ctx);
}

/** The key file is only created once a secret is actually stored or read. */
export function lazyBox(key: () => Buffer): SecretBox {
  let box: SecretBox | null = null;
  const get = () => (box ??= secretBox(key()));
  return { seal: (p) => get().seal(p), open: (s) => get().open(s) };
}
