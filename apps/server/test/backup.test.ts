import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dbPath, openDb } from "../src/db/client.js";
import { books, households, userIdentities, users } from "../src/db/schema.js";
import { createBackup, listBackups, pruneBackups, restoreBackup, RestoreError } from "../src/backup/backup.js";
import { nextRunAt, parseBackupTime } from "../src/backup/schedule.js";

let dir: string;
let configDir: string;
let backupDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-backup-"));
  configDir = join(dir, "config");
  backupDir = join(configDir, "backups");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed() {
  const { db, close } = openDb(dbPath(configDir));
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const mk = (displayName: string, role: "admin" | "kid", email: string) => {
    const [u] = db.insert(users).values({ householdId: home!.id, displayName, role, birthYear: role === "kid" ? 2018 : null }).returning().all();
    db.insert(userIdentities).values({ userId: u!.id, provider: "tinyauth", subject: email }).run();
  };
  mk("Admin", "admin", "admin@example.com");
  mk("Emma", "kid", "emma@example.com");
  db.insert(books).values({ title: "Before", sortTitle: "before", rating: "kids", approved: true }).run();
  writeFileSync(join(configDir, "secret.key"), Buffer.alloc(32, 1));
  return { db, close };
}

describe("backups", () => {
  it("backs up through the admin API, lists, downloads, and refuses kids", async () => {
    const { db, close } = seed();
    const app = await buildApp(loadConfig({ TRUSTED_PROXIES: "127.0.0.1", LOG_LEVEL: "error", CONFIG_DIR: configDir } as NodeJS.ProcessEnv), db, {
      integrations: { secretKey: Buffer.alloc(32, 1) },
    });
    try {
      const kid = await app.inject({ method: "POST", url: "/api/admin/backups", headers: { "remote-email": "emma@example.com" } });
      expect(kid.statusCode).toBe(403);
      const anon = await app.inject({ method: "GET", url: "/api/admin/backups" });
      expect(anon.statusCode).toBe(401);

      const res = await app.inject({ method: "POST", url: "/api/admin/backups", headers: { "remote-email": "admin@example.com" } });
      expect(res.statusCode).toBe(201);
      const b = res.json();
      expect(b.hasKey).toBe(true);
      expect(b.reason).toBe("manual");

      const list = await app.inject({ method: "GET", url: "/api/admin/backups", headers: { "remote-email": "admin@example.com" } });
      expect(list.json().backups.map((x: { name: string }) => x.name)).toEqual([b.name]);
      expect(list.json().schedule).toBe("03:00");

      const dl = await app.inject({ method: "GET", url: `/api/admin/backups/${b.name}/download`, headers: { "remote-email": "admin@example.com" } });
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.subarray(0, 15).toString()).toBe("SQLite format 3");
      const bad = await app.inject({ method: "GET", url: `/api/admin/backups/..%2F..%2Fsecret.key/download`, headers: { "remote-email": "admin@example.com" } });
      expect(bad.statusCode).toBe(404);
    } finally {
      await app.close();
      close();
    }
  });

  it("keeps only the newest N, never pruning before-restore copies", async () => {
    const { db, close } = seed();
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const t0 = Date.UTC(2026, 10, 1, 3);
    for (let i = 0; i < 5; i++) await createBackup({ sqlite, configDir, backupDir, keep: 3, now: t0 + i * 86_400_000 });
    close();
    expect(listBackups(backupDir).map((b) => b.name)).toEqual([
      "2026-11-05T03-00-00Z",
      "2026-11-04T03-00-00Z",
      "2026-11-03T03-00-00Z",
    ]);
    await restoreBackup({ configDir, backupDir, name: "2026-11-03T03-00-00Z", now: t0 + 10 * 86_400_000 });
    pruneBackups(backupDir, 1);
    const left = listBackups(backupDir);
    expect(left.map((b) => b.reason).sort()).toEqual(["before-restore", "manual"]);
  });

  it("restores a backup over a changed database, keeping the old one", async () => {
    const { db, close } = seed();
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const first = await createBackup({ sqlite, configDir, backupDir, keep: 7 });
    db.update(books).set({ title: "After" }).where(eq(books.title, "Before")).run();
    db.insert(books).values({ title: "New", sortTitle: "new", rating: "adult", approved: true }).run();
    close();
    writeFileSync(join(configDir, "secret.key"), Buffer.alloc(32, 9));

    const r = await restoreBackup({ configDir, backupDir, name: "latest" });
    expect(r.restored.name).toBe(first.name);
    expect(r.savedAs).toBeTruthy();

    const after = openDb(dbPath(configDir));
    expect(after.db.select({ t: books.title }).from(books).all().map((b) => b.t)).toEqual(["Before"]);
    after.close();
    // The key that encrypted saved secrets comes back with the database.
    expect(Buffer.from(fs.readFileSync(join(configDir, "secret.key"))).equals(Buffer.alloc(32, 1))).toBe(true);

    // And the restore can be undone from the saved copy.
    await restoreBackup({ configDir, backupDir, name: r.savedAs! });
    const undone = openDb(dbPath(configDir));
    expect(undone.db.select({ t: books.title }).from(books).all().map((b) => b.t).sort()).toEqual(["After", "New"]);
    undone.close();
  });

  it("restores into an empty config folder (a fresh container)", async () => {
    const { db, close } = seed();
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const b = await createBackup({ sqlite, configDir, backupDir, keep: 7 });
    close();
    const fresh = join(dir, "fresh");
    const freshBackups = join(fresh, "backups");
    mkdirSync(freshBackups, { recursive: true });
    fs.cpSync(join(backupDir, b.name), join(freshBackups, b.name), { recursive: true });
    const r = await restoreBackup({ configDir: fresh, backupDir: freshBackups, name: b.name });
    expect(r.savedAs).toBeNull();
    const back = openDb(dbPath(fresh));
    expect(back.db.select().from(users).all()).toHaveLength(2);
    back.close();
    expect(existsSync(join(fresh, "secret.key"))).toBe(true);
  });

  it("refuses a damaged or foreign file", async () => {
    const name = "2026-11-01T03-00-00Z";
    mkdirSync(join(backupDir, name), { recursive: true });
    writeFileSync(join(backupDir, name, "bookbandit.sqlite"), "not a database at all".repeat(100));
    await expect(restoreBackup({ configDir, backupDir, name })).rejects.toBeInstanceOf(RestoreError);
    const other = new Database(join(backupDir, name, "bookbandit.sqlite.tmp"));
    other.exec("create table t(x)");
    other.close();
    fs.renameSync(join(backupDir, name, "bookbandit.sqlite.tmp"), join(backupDir, name, "bookbandit.sqlite"));
    await expect(restoreBackup({ configDir, backupDir, name })).rejects.toThrow(/isn't a Bookbandit database/);
    await expect(restoreBackup({ configDir, backupDir, name: "nope" })).rejects.toThrow(/No backup called/);
  });
});

describe("backup schedule", () => {
  it("parses times and finds the next run", () => {
    expect(parseBackupTime("off")).toBeNull();
    expect(parseBackupTime("3:30")).toEqual({ hour: 3, minute: 30 });
    expect(() => parseBackupTime("25:00")).toThrow();
    expect(() => parseBackupTime("3am")).toThrow();
    const now = new Date(2026, 10, 14, 4, 0).getTime();
    expect(new Date(nextRunAt({ hour: 3, minute: 0 }, now)).getDate()).toBe(15);
    expect(new Date(nextRunAt({ hour: 5, minute: 0 }, now)).getHours()).toBe(5);
  });
});
