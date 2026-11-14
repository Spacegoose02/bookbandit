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
import { aiAdminJobRoutes, aiAdminRoutes } from "./admin-routes.js";
import { registerAiJobs } from "./jobs.js";
import { aiRoutes } from "./routes.js";
import { fileRatedBooks } from "./review.js";
import { getAiSettings } from "./settings.js";

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
  // app.jobs comes from the jobs plugin, registered before this one (app.ts).
  registerAiJobs(ctx, app.jobs);
  await app.register(aiRoutes, { ...ctx, runner: app.jobs });
  await app.register(aiAdminRoutes, { ...ctx, runner: app.jobs });
  await app.register(aiAdminJobRoutes, { ...ctx, runner: app.jobs });
  // Books Barnaby rated before filing existed (or while the server was down) leave the Inbox.
  app.addHook("onReady", async () => {
    try {
      const r = fileRatedBooks(ctx.db, getAiSettings(ctx.db, ctx.box).ratingHelper);
      if (r.approved || r.rated) app.log.info(r, "filed books Barnaby has rated");
    } catch (err) {
      app.log.warn({ err }, "couldn't file books Barnaby has rated");
    }
  });
}

function lazyBox(key: () => Buffer): SecretBox {
  let box: SecretBox | null = null;
  const get = () => (box ??= secretBox(key()));
  return { seal: (p) => get().seal(p), open: (s) => get().open(s) };
}
