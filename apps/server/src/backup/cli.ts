/**
 * Backup command line, for when the server is stopped (or from a one-off container):
 *
 *   node apps/server/dist/backup/cli.js list
 *   node apps/server/dist/backup/cli.js backup
 *   node apps/server/dist/backup/cli.js restore latest|<name>
 *
 * Docker: `docker run --rm -v <appdata>:/config <image> restore latest` (the entrypoint
 * forwards `backup`, `restore` and `list-backups`). Uses CONFIG_DIR and BACKUP_DIR like the server.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createBackup, DB_FILE, defaultBackupDir, listBackups, restoreBackup, RestoreError } from "./backup.js";

const configDir = resolve(process.env.CONFIG_DIR ?? "./data/config");
const backupDir = defaultBackupDir(configDir, process.env.BACKUP_DIR);
const keep = Number(process.env.BACKUP_KEEP ?? 7);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "list":
    case "list-backups": {
      const all = listBackups(backupDir);
      if (!all.length) console.log(`No backups in ${backupDir}`);
      for (const b of all) {
        console.log(`${b.name}  ${mb(b.sizeBytes).padStart(9)}  ${b.reason}${b.hasKey ? "" : "  (no secret.key)"}`);
      }
      return 0;
    }
    case "backup": {
      const live = join(configDir, DB_FILE);
      if (!existsSync(live)) {
        console.error(`No database at ${live}`);
        return 1;
      }
      const sqlite = new Database(live);
      try {
        const b = await createBackup({ sqlite, configDir, backupDir, keep, reason: "manual" });
        console.log(`Backed up to ${join(backupDir, b.name)} (${mb(b.sizeBytes)})`);
      } finally {
        sqlite.close();
      }
      return 0;
    }
    case "restore": {
      if (!arg) {
        console.error("Which backup? Use `restore latest` or `restore <name>` (see `list`).");
        return 2;
      }
      const r = await restoreBackup({ configDir, backupDir, name: arg });
      console.log(`Restored ${r.restored.name} into ${join(configDir, DB_FILE)}.`);
      if (r.savedAs) console.log(`The database that was there before is saved as backup ${r.savedAs}.`);
      if (!r.restored.hasKey) {
        console.log("That backup has no secret.key: re-enter saved API keys and passwords in the admin settings.");
      }
      console.log("Start Bookbandit again. Run a library scan if books were added since the backup.");
      return 0;
    }
    default:
      console.log("Usage: list | backup | restore <latest|name>");
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err instanceof RestoreError ? err.message : err.stack ?? err.message);
    process.exit(1);
  },
);
