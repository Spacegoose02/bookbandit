# Backups

Nightly SQLite backups, an admin "Back up now", and a restore command.

- **What:** a consistent copy of `bookbandit.sqlite` made with SQLite's online backup API (safe
  while the server runs), the `secret.key` that decrypts saved API keys and passwords, and a
  `manifest.json`. Covers, caches and `/books` are not included: covers and metadata come back
  with a rescan, and the books are your own files.
- **Where:** `BACKUP_DIR` (default `CONFIG_DIR/backups`), one folder per backup named by UTC time,
  for example `2026-11-14T03-00-00Z/`. A backup is written to a hidden `.…partial` folder and
  renamed when complete.
- **When:** `BACKUP_TIME` (default `03:00`, server local time, set `TZ`), or `off`. Keeps the newest
  `BACKUP_KEEP` (default 7; 0 keeps all). Copies saved before a restore are never pruned.

## API (admins only)

| Route | What it does |
| --- | --- |
| `GET /api/admin/backups` | `{ dir, keep, schedule, nextAt, running, lastError, backups: [{ name, createdAt, sizeBytes, hasKey, reason, version }] }` |
| `POST /api/admin/backups` | Back up now; 201 with the new backup. A second press while one runs waits for that one. |
| `GET /api/admin/backups/:name/download` | The backup's database file (without the key). |

## Restore

Stop the server first: it holds the database open. Then:

```sh
node apps/server/dist/backup/cli.js list
node apps/server/dist/backup/cli.js restore latest     # or a name from the list
```

In Docker, `docker run --rm -v <appdata>:/config <image> restore latest` (see `docker/README.md`).
The restore checks the backup (`PRAGMA integrity_check` and that it is a Bookbandit database),
saves the current database as a `before-restore` backup, then puts the backup and its key in
place. Migrations newer than the backup run on the next start.
