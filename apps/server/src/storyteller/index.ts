/**
 * Storyteller mode (toddlers): routes plus the audio guard that makes nightly limits hold on the
 * server. Registered from app.ts BEFORE the integrations plugin, because the guard is a root-level
 * hook and Fastify only applies it to routes registered after it.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import { audioAllowed } from "./service.js";
import { storytellerRoutes } from "./routes.js";

/** Audiobookshelf track streaming (apps/server/src/integrations/audiobookshelf/routes.ts). */
const GUARDED_ROUTES = new Set(["/api/books/:id/audio/tracks/:index"]);

export const storytellerPlugin = fp(async (app: FastifyInstance, opts: { db: Db }) => {
  app.addHook("preHandler", async (req: FastifyRequest, reply) => {
    if (!GUARDED_ROUTES.has(req.routeOptions.url ?? "")) return;
    const reader = req.reader;
    if (!reader || reader.role !== "kid") return;
    const bookId = (req.params as { id?: string }).id;
    if (!bookId) return;
    if (!audioAllowed(opts.db, reader.userId, bookId)) {
      return reply.code(403).send({ error: "Storytime is over for tonight", goodnight: true });
    }
  });
  await app.register(storytellerRoutes, { db: opts.db });
});
