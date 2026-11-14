/**
 * Nightly SQLite backups and the admin backup API.
 *
 *   GET  /api/admin/backups                 list, schedule, last error
 *   POST /api/admin/backups                 back up now
 *   GET  /api/admin/backups/:name/download  the backup's bookbandit.sqlite (no key file)
 *
 * Restoring is a command, run with the server stopped: see ./README.md and ./cli.ts.
 */
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type Database from "better-sqlite3";
import type { Db } from "../db/client.js";
import { httpError, requireAdmin } from "../auth/plugin.js";
import { backupDbPath, createBackup, defaultBackupDir, listBackups, type BackupInfo } from "./backup.js";

export { defaultBackupDir };
import { nextRunAt, parseBackupTime } from "./schedule.js";

export interface BackupOptions {
  db: Db;
  configDir: string;
  /** Default CONFIG_DIR/backups. */
  backupDir?: string;
  /** Default 7. 0 keeps every backup. */
  keep?: number;
  /** "03:00" (server local time) or "off". */
  time?: string;
  now?: () => number;
}

export const backupPlugin = fp(async (app: FastifyInstance, opts: BackupOptions) => {
  const now = opts.now ?? Date.now;
  const backupDir = defaultBackupDir(opts.configDir, opts.backupDir);
  const keep = opts.keep ?? 7;
  const time = parseBackupTime(opts.time ?? "03:00");
  const sqlite = (opts.db as unknown as { $client: Database.Database }).$client;

  let running: Promise<BackupInfo> | null = null;
  let lastError: { at: number; message: string } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let nextAt: number | null = null;

  /** One backup at a time; a second caller gets the one already running. */
  function backUp(reason: BackupInfo["reason"]): Promise<BackupInfo> {
    running ??= createBackup({ sqlite, configDir: opts.configDir, backupDir, keep, reason, now: now() })
      .then((b) => {
        lastError = null;
        app.log.info({ backup: b.name, bytes: b.sizeBytes }, "database backup written");
        return b;
      })
      .catch((err: Error) => {
        lastError = { at: now(), message: err.message };
        app.log.error({ err }, "database backup failed");
        throw err;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  function schedule() {
    if (!time) return;
    nextAt = nextRunAt(time, now());
    // setTimeout tops out at ~24.8 days; a day is well inside that.
    timer = setTimeout(() => {
      backUp("scheduled")
        .catch(() => {})
        .finally(schedule);
    }, Math.max(1000, nextAt - now()));
    timer.unref();
  }

  // Only a real server backs up on a timer; app.inject() tests don't listen.
  app.addHook("onListen", async () => schedule());
  app.addHook("onClose", async () => {
    if (timer) clearTimeout(timer);
    await running?.catch(() => {});
  });

  app.get("/api/admin/backups", async (req) => {
    requireAdmin(req);
    return {
      dir: backupDir,
      keep,
      schedule: time ? `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}` : null,
      nextAt,
      running: !!running,
      lastError,
      backups: listBackups(backupDir),
    };
  });

  app.post("/api/admin/backups", async (req, reply) => {
    requireAdmin(req);
    try {
      const b = await backUp("manual");
      reply.status(201);
      return b;
    } catch (err) {
      throw httpError(500, `Backup failed: ${(err as Error).message}`);
    }
  });

  app.get<{ Params: { name: string } }>("/api/admin/backups/:name/download", async (req, reply) => {
    requireAdmin(req);
    const file = backupDbPath(backupDir, req.params.name);
    if (!file) throw httpError(404, "Not found");
    reply
      .header("content-type", "application/vnd.sqlite3")
      .header("content-disposition", `attachment; filename="bookbandit-${req.params.name}.sqlite"`)
      .header("cache-control", "no-store");
    return reply.send(createReadStream(file));
  });
});
