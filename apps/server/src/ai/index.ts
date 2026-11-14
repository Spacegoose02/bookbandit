/**
 * Barnaby, the AI helper. Optional: nothing here runs until an admin adds a provider.
 * Setup for every provider and SearXNG: docs/ai.md.
 */
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Db } from "../db/client.js";
import { loadOrCreateKey, secretBox, type SecretBox } from "../integrations/secrets.js";
import type { FetchLike } from "./providers/types.js";
import type { AiContext } from "./context.js";
import { aiAdminRoutes } from "./admin-routes.js";
import { createRatingRunner } from "./rating.js";
import { aiRoutes } from "./routes.js";

export interface AiOptions {
  db: Db;
  configDir: string;
  booksDir: string;
  /** Tests: fixed key instead of CONFIG_DIR/secret.key. */
  secretKey?: Buffer;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export async function aiPlugin(app: FastifyInstance, opts: AiOptions) {
  const ctx: AiContext = {
    db: opts.db,
    box: lazyBox(() => opts.secretKey ?? loadOrCreateKey(opts.configDir)),
    fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init)),
    booksDir: opts.booksDir,
    now: opts.now ?? (() => new Date()),
  };
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Bad request", message: "Invalid request", issues: err.issues });
    return reply.send(err);
  });
  await app.register(aiRoutes, ctx);
  await app.register(aiAdminRoutes, { ...ctx, runner: createRatingRunner(ctx) });
}

function lazyBox(key: () => Buffer): SecretBox {
  let box: SecretBox | null = null;
  const get = () => (box ??= secretBox(key()));
  return { seal: (p) => get().seal(p), open: (s) => get().open(s) };
}
