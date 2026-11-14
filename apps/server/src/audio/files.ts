/**
 * File moves for audiobooks, called from the admin inbox (reject) so a rejected audiobook
 * doesn't come back on the next scan. Only the audiobook's own files are touched (its tracks and
 * its cover), never the rest of the folder, which may hold another book.
 */
import { mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { insideRoot } from "../library/serve.js";
import { audioProgress } from "../integrations/schema.js";
import { audioBookmarks, audiobooks, audioPrefs } from "./schema.js";

/** Moves (or deletes) a book's audiobook files to AUDIOBOOKS_DIR/.rejected. Returns where they went. */
export async function rejectAudiobookFiles(db: Db, audiobooksDir: string, bookId: string, deleteFiles: boolean): Promise<string[]> {
  const root = resolve(audiobooksDir);
  const rows = db.select().from(audiobooks).where(eq(audiobooks.bookId, bookId)).all();
  const moved: string[] = [];
  for (const row of rows) {
    const rels = [...row.tracks.map((t) => t.relPath), ...(row.coverRelPath ? [row.coverRelPath] : [])];
    for (const rel of rels) {
      const abs = insideRoot(root, rel);
      if (!abs) continue;
      if (deleteFiles) {
        await rm(abs, { force: true });
        continue;
      }
      const target = insideRoot(root, join(".rejected", rel));
      if (!target) continue;
      await mkdir(dirname(target), { recursive: true });
      const ok = await rename(abs, target).then(
        () => true,
        (err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
          return false;
        },
      );
      if (ok) moved.push(relative(root, target).split(sep).join("/"));
    }
    // Tidy up folders left empty (the book folder and its disc folders), never above it.
    const folder = insideRoot(root, row.relPath);
    if (folder) {
      const dirs = [...new Set(rels.map((r) => insideRoot(root, dirname(r))).filter((d): d is string => !!d))];
      for (const d of dirs.sort((a, b) => b.length - a.length)) if (d.startsWith(folder)) await rmdir(d).catch(() => undefined);
    }
    db.delete(audiobooks).where(eq(audiobooks.id, row.id)).run();
  }
  return moved;
}

type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * Merging two books (admin inbox): the audiobooks, listening bookmarks and player settings
 * follow, and listening positions move with newest wins, like reading progress.
 */
export function moveAudioToBook(tx: Tx, fromId: string, intoId: string): void {
  tx.update(audiobooks).set({ bookId: intoId }).where(eq(audiobooks.bookId, fromId)).run();
  tx.update(audioBookmarks).set({ bookId: intoId, updatedAt: Date.now() }).where(eq(audioBookmarks.bookId, fromId)).run();
  for (const p of tx.select().from(audioPrefs).where(eq(audioPrefs.bookId, fromId)).all()) {
    tx.insert(audioPrefs).values({ ...p, bookId: intoId }).onConflictDoNothing().run();
  }
  for (const p of tx.select().from(audioProgress).where(eq(audioProgress.bookId, fromId)).all()) {
    const existing = tx
      .select()
      .from(audioProgress)
      .where(and(eq(audioProgress.userId, p.userId), eq(audioProgress.bookId, intoId)))
      .get();
    if (!existing) tx.insert(audioProgress).values({ ...p, bookId: intoId }).run();
    else if (p.clientUpdatedAt > existing.clientUpdatedAt) {
      const { userId: _u, bookId: _b, ...rest } = p;
      tx.update(audioProgress)
        .set(rest)
        .where(and(eq(audioProgress.userId, p.userId), eq(audioProgress.bookId, intoId)))
        .run();
    }
  }
}
