/**
 * Kids' goals, badges and reading bedtime: routes plus the bedtime guard that makes bedtime
 * hold on the server. Registered from app.ts BEFORE the book, reading-time and integrations
 * routes, because the guard is a root-level hook and Fastify only applies it to routes
 * registered after it.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { bedtimeStatus } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { getSettings as storytellerSettings } from "../storyteller/service.js";
import { rewardsRoutes } from "./routes.js";
import { getBedtime } from "./service.js";

/**
 * What a kid can't do at bedtime: open a book file (web reader, tablet downloads), count
 * reading time, or stream an audiobook. Storyteller profiles keep their audio, because
 * storyteller has its own nightly limits for bedtime stories.
 */
export const BEDTIME_ROUTES = new Set([
  "/api/books/:id/files/:fileId",
  "/api/reading/heartbeat",
  "/api/books/:id/audio/tracks/:index",
]);
const AUDIO_ROUTE = "/api/books/:id/audio/tracks/:index";

export interface RewardsOptions {
  db: Db;
  now?: () => number;
}

export const rewardsPlugin = fp(async (app: FastifyInstance, opts: RewardsOptions) => {
  const now = opts.now ?? Date.now;
  app.addHook("preHandler", async (req: FastifyRequest, reply) => {
    const route = req.routeOptions.url ?? "";
    if (!BEDTIME_ROUTES.has(route)) return;
    const reader = req.reader;
    if (!reader || reader.role !== "kid") return;
    const status = bedtimeStatus(getBedtime(opts.db, reader.userId), now());
    if (!status.active) return;
    if (route === AUDIO_ROUTE && storytellerSettings(opts.db, reader.userId).enabled) return;
    return reply.code(403).send({ error: "It's bedtime! Books open again in the morning.", bedtime: true, endsAt: status.endsAt });
  });
  await app.register(rewardsRoutes, { db: opts.db, now: opts.now });
});
