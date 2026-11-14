/**
 * Read-aloud narration: a local text-to-speech server (Kokoro-FastAPI or Piper) reads books aloud,
 * one sentence at a time, with word timings when the server has them. See README.md.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { lazyBox } from "../integrations/index.js";
import { loadOrCreateKey } from "../integrations/secrets.js";
import { ClipCache } from "./cache.js";
import { defaultCacheDir, narrationRoutes } from "./routes.js";
import { getNarrationSettings } from "./settings.js";
import type { FetchLike } from "./tts.js";

export interface NarrationOptions {
  db: Db;
  configDir: string;
  booksDir: string;
  secretKey?: Buffer;
  fetchImpl?: FetchLike;
  /** Tests: a temp folder. */
  cacheDir?: string;
}

export async function narrationPlugin(app: FastifyInstance, opts: NarrationOptions) {
  const box = lazyBox(() => opts.secretKey ?? loadOrCreateKey(opts.configDir));
  const cache = new ClipCache(opts.cacheDir ?? defaultCacheDir(opts.configDir), () => getNarrationSettings(opts.db, box).cacheMb * 1024 * 1024);
  await app.register(narrationRoutes, {
    db: opts.db,
    box,
    booksDir: opts.booksDir,
    cache,
    fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init)),
  });
}
