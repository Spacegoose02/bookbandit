/** Word help and after-chapter quizzes for kids (and anyone else who wants them). See README.md. */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { lazyBox } from "../integrations/index.js";
import { loadOrCreateKey } from "../integrations/secrets.js";
import type { FetchLike } from "../ai/providers/types.js";
import { learningRoutes } from "./routes.js";

export interface LearningOptions {
  db: Db;
  configDir: string;
  booksDir: string;
  secretKey?: Buffer;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export async function learningPlugin(app: FastifyInstance, opts: LearningOptions) {
  await app.register(learningRoutes, {
    db: opts.db,
    box: lazyBox(() => opts.secretKey ?? loadOrCreateKey(opts.configDir)),
    fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init)),
    booksDir: opts.booksDir,
    configDir: opts.configDir,
    now: opts.now ?? (() => new Date()),
  });
}
