/**
 * SQLite backups. Each backup is a folder under the backup dir (default CONFIG_DIR/backups):
 *
 *   backups/2026-11-14T03-00-00Z/
 *     bookbandit.sqlite   consistent copy made with SQLite's online backup API (safe while running)
 *     secret.key          the key that encrypts saved API keys and passwords (if there is one)
 *     manifest.json       when, which app version, which migrations
 *
 * Covers, caches and the library itself are not backed up: covers and metadata come back with a
 * rescan, and /books is your own folder. People, progress, bookmarks, ratings and series live
 * only in the database, which is why this exists.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

export const DB_FILE = "bookbandit.sqlite";
export const KEY_FILE = "secret.key";
const MANIFEST = "manifest.json";
/** 2026-11-14T03-00-00Z, optionally with -2, -3 when two land in the same second. */
const NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/;

export interface BackupInfo {
  name: string;
  createdAt: number;
  sizeBytes: number;
  /** Saved API keys can be decrypted after restoring only when the key file was there. */
  hasKey: boolean;
  reason: "scheduled" | "manual" | "before-restore" | "unknown";
  version: string | null;
}

interface Manifest {
  createdAt: number;
  reason: BackupInfo["reason"];
  version: string | null;
  migrations: number | null;
}

export function defaultBackupDir(configDir: string, fromEnv?: string): string {
  return resolve(fromEnv || join(configDir, "backups"));
}

export function isBackupName(name: string): boolean {
  return NAME_RE.test(name);
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export interface CreateBackupOptions {
  /** The live database (better-sqlite3 handle). */
  sqlite: Database.Database;
  configDir: string;
  backupDir: string;
  /** How many backups to keep; older ones are deleted after a successful backup. 0 keeps all. */
  keep: number;
  reason?: BackupInfo["reason"];
  now?: number;
}

/** Make a backup and prune old ones. Safe while the server is running. */
export async function createBackup(opts: CreateBackupOptions): Promise<BackupInfo> {
  const now = opts.now ?? Date.now();
  const dir = resolve(opts.backupDir);
  mkdirSync(dir, { recursive: true });
  let name = stamp(now);
  for (let i = 2; existsSync(join(dir, name)) || existsSync(join(dir, `.${name}.partial`)); i++) name = `${stamp(now)}-${i}`;

  // Write into a hidden folder and rename at the end, so a crash never leaves a half backup
  // that looks complete.
  const partial = join(dir, `.${name}.partial`);
  mkdirSync(partial, { recursive: true });
  try {
    await opts.sqlite.backup(join(partial, DB_FILE));
    const key = join(resolve(opts.configDir), KEY_FILE);
    if (existsSync(key)) copyFileSync(key, join(partial, KEY_FILE));
    const manifest: Manifest = {
      createdAt: now,
      reason: opts.reason ?? "manual",
      version: process.env.BOOKBANDIT_VERSION ?? null,
      migrations: migrationCount(opts.sqlite),
    };
    writeFileSync(join(partial, MANIFEST), JSON.stringify(manifest, null, 2));
    renameSync(partial, join(dir, name));
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  pruneBackups(dir, opts.keep);
  return readInfo(dir, name)!;
}

function migrationCount(sqlite: Database.Database): number | null {
  try {
    return (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n;
  } catch {
    return null;
  }
}

/** Newest first. Ignores anything in the folder that isn't a finished backup. */
export function listBackups(backupDir: string): BackupInfo[] {
  const dir = resolve(backupDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isBackupName)
    .map((n) => readInfo(dir, n))
    .filter((b): b is BackupInfo => !!b)
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

function readInfo(dir: string, name: string): BackupInfo | null {
  const db = join(dir, name, DB_FILE);
  if (!existsSync(db)) return null;
  let manifest: Partial<Manifest> = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, name, MANIFEST), "utf8")) as Manifest;
  } catch {
    /* hand-copied backup without a manifest */
  }
  const st = statSync(db);
  return {
    name,
    createdAt: manifest.createdAt ?? st.mtimeMs,
    sizeBytes: st.size,
    hasKey: existsSync(join(dir, name, KEY_FILE)),
    reason: manifest.reason ?? "unknown",
    version: manifest.version ?? null,
  };
}

/** Delete all but the newest `keep` backups. Backups taken before a restore are never pruned. */
export function pruneBackups(backupDir: string, keep: number): string[] {
  if (keep <= 0) return [];
  const removable = listBackups(backupDir).filter((b) => b.reason !== "before-restore");
  const gone = removable.slice(keep).map((b) => b.name);
  for (const n of gone) rmSync(join(resolve(backupDir), n), { recursive: true, force: true });
  return gone;
}

/** The path of a backup's database file, or undefined when there's no such backup. */
export function backupDbPath(backupDir: string, name: string): string | undefined {
  if (!isBackupName(name)) return undefined;
  const p = join(resolve(backupDir), name, DB_FILE);
  return existsSync(p) ? p : undefined;
}

export class RestoreError extends Error {}

export interface RestoreOptions {
  configDir: string;
  backupDir: string;
  /** A backup name, or "latest". */
  name: string;
  now?: number;
}

export interface RestoreResult {
  restored: BackupInfo;
  /** Backup of the database that was in place before, or null on an empty /config. */
  savedAs: string | null;
}

/**
 * Put a backup back. Run it with the server stopped: the server keeps the database open.
 * The current database is first saved as a "before-restore" backup, so a restore can be undone
 * by restoring that one.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const configDir = resolve(opts.configDir);
  const all = listBackups(opts.backupDir);
  const info = opts.name === "latest" ? all.find((b) => b.reason !== "before-restore") : all.find((b) => b.name === opts.name);
  if (!info) {
    throw new RestoreError(
      all.length
        ? `No backup called "${opts.name}". Backups: ${all.map((b) => b.name).join(", ")}`
        : `No backups in ${resolve(opts.backupDir)}`,
    );
  }
  const source = join(resolve(opts.backupDir), info.name, DB_FILE);
  checkIntegrity(source);

  mkdirSync(configDir, { recursive: true });
  const live = join(configDir, DB_FILE);
  let savedAs: string | null = null;
  if (existsSync(live)) {
    const current = new Database(live);
    try {
      savedAs = (
        await createBackup({
          sqlite: current,
          configDir,
          backupDir: opts.backupDir,
          keep: 0,
          reason: "before-restore",
          now: opts.now,
        })
      ).name;
    } finally {
      current.close();
    }
  }

  // Copy to a temp name and rename over, so a failed copy leaves the old database in place.
  const tmp = `${live}.restoring`;
  copyFileSync(source, tmp);
  for (const side of ["-wal", "-shm"]) rmSync(live + side, { force: true });
  renameSync(tmp, live);

  const key = join(resolve(opts.backupDir), info.name, KEY_FILE);
  if (existsSync(key)) copyFileSync(key, join(configDir, KEY_FILE));
  return { restored: info, savedAs };
}

/** Throws unless the file is a readable, intact SQLite database with Bookbandit's tables. */
export function checkIntegrity(file: string): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const res = db.pragma("integrity_check", { simple: true });
    if (res !== "ok") throw new RestoreError(`The backup is damaged: ${String(res)}`);
    const t = db.prepare("select name from sqlite_master where type='table' and name='users'").get();
    if (!t) throw new RestoreError("That file isn't a Bookbandit database");
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(`Can't read the backup: ${(err as Error).message}`);
  } finally {
    db?.close();
  }
}
