/**
 * Own the audio (ws/audio): local audiobooks from AUDIOBOOKS_DIR, the listening API for both
 * local and Audiobookshelf audio, and keeping positions in step with Audiobookshelf.
 *
 * Registered from app.ts after the storyteller plugin, whose bedtime guard on
 * /api/books/:id/audio/tracks/:index must exist before the track route is added.
 * Decorates `app.audio` so the job runner and tests can reach the scanner and the ABS sync.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Db } from "../db/client.js";
import type { LookupOptions } from "../metadata/lookup.js";
import type { SecretBox } from "../integrations/secrets.js";
import type { FetchLike } from "../integrations/audiobookshelf/client.js";
import { AbsSync } from "../integrations/audiobookshelf/sync.js";
import { absAccountRoutes } from "../integrations/audiobookshelf/accounts.js";
import { AudiobookService } from "./service.js";
import { audioRoutes } from "./routes.js";

export interface AudioOptions {
  db: Db;
  box: SecretBox;
  audiobooksDir: string;
  configDir: string;
  scanOnStart: boolean;
  lookup: () => LookupOptions | false;
  fetchImpl?: FetchLike;
  /** Tests: how long the player waits for ABS. */
  pullTimeoutMs?: number;
}

declare module "fastify" {
  interface FastifyInstance {
    audio: { service: AudiobookService; sync: AbsSync };
  }
}

export const audioPlugin = fp(async (app: FastifyInstance, opts: AudioOptions) => {
  const audiobooksDir = resolve(opts.audiobooksDir);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const service = new AudiobookService({ db: opts.db, audiobooksDir, configDir: opts.configDir, online: opts.lookup, log: app.log });
  const sync = new AbsSync({ db: opts.db, box: opts.box, fetchImpl, log: app.log, pullTimeoutMs: opts.pullTimeoutMs });
  app.decorate("audio", { service, sync });

  if (app.hasDecorator("jobs")) {
    app.jobs.register("audiobooks.scan", async () => {
      const wasRunning = service.getStatus().running;
      let report = await service.startScan();
      if (wasRunning) report = await service.startScan();
      return { added: report.added, linked: report.linked, removed: report.removed, errors: report.errors.length };
    });
  }

  if (opts.scanOnStart) {
    app.addHook("onListen", async () => {
      const entries = await readdir(audiobooksDir).catch(() => []);
      if (!entries.length) {
        app.log.info({ audiobooksDir }, "audiobooks folder is missing or empty; skipping startup scan");
        return;
      }
      service.startScan().catch(() => {
        // reported through getStatus().lastError and the log
      });
    });
  }
  app.addHook("onClose", async () => {
    await sync.whenIdle();
  });

  await app.register(audioRoutes, { db: opts.db, box: opts.box, fetchImpl, audiobooksDir, configDir: opts.configDir, service, sync });
  await app.register(absAccountRoutes, { db: opts.db, box: opts.box, sync });
});
