/**
 * Audiobook scan: makes the `audiobooks` table match the folders under AUDIOBOOKS_DIR.
 *
 * - An unchanged folder (same files, sizes and mtimes) is skipped without reading tags.
 * - A changed folder is read again; it keeps its book (and everyone's position).
 * - A new folder whose files match one that vanished (same names and sizes) is a move.
 * - A new folder is read, matched to the ebook of the same work (same ISBN, or same title and
 *   author, the library's own rule), or becomes a new book waiting in the admin inbox with a
 *   rating from its folders and tags. Same content lock and approval as ebooks.
 * - A folder that is gone loses its row; the book stays, like a missing ebook file.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { autoRating, shouldReplaceRating } from "../metadata/rating.js";
import { saveCover } from "../library/covers.js";
import { enrichBook } from "../library/enrich.js";
import { addGenreTags, bookFieldsFrom, findSameWork, setBookAuthors, setBookSeries } from "../library/store.js";
import { audiobooks } from "./schema.js";
import { probeAudiobook, readCoverFile } from "./probe.js";
import { contentKey, unitSignature, walkAudiobooks, type AudiobookUnit } from "./walk.js";

export interface AudioScanOptions {
  db: Db;
  audiobooksDir: string;
  configDir: string;
  online: LookupOptions | false;
  onProgress?: (done: number, total: number) => void;
}

export interface AudioScanReport {
  startedAt: number;
  finishedAt: number;
  foldersSeen: number;
  unchanged: number;
  /** New books created (waiting in the inbox). */
  added: number;
  /** Audiobooks attached to an existing book (the ebook of the same work). */
  linked: number;
  updated: number;
  moved: number;
  removed: number;
  errors: { relPath: string; error: string }[];
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export async function scanAudiobooks(opts: AudioScanOptions): Promise<AudioScanReport> {
  const { db } = opts;
  const report: AudioScanReport = {
    startedAt: Date.now(),
    finishedAt: 0,
    foldersSeen: 0,
    unchanged: 0,
    added: 0,
    linked: 0,
    updated: 0,
    moved: 0,
    removed: 0,
    errors: [],
  };

  const units = await walkAudiobooks(opts.audiobooksDir);
  report.foldersSeen = units.length;
  const onDisk = new Set(units.map((u) => u.relPath));
  const known = new Map(db.select().from(audiobooks).all().map((r) => [r.relPath, r]));
  const vanished = new Map<string, typeof audiobooks.$inferSelect>();
  for (const row of known.values()) if (!onDisk.has(row.relPath)) vanished.set(contentKey(row.tracks), row);

  let done = 0;
  for (const unit of units) {
    try {
      const signature = sha1(unitSignature(unit));
      const row = known.get(unit.relPath);
      if (row?.signature === signature) report.unchanged++;
      else if (row) {
        await refresh(opts, row.id, unit, signature, report);
        report.updated++;
      } else {
        const movedFrom = vanished.get(contentKey(unit.files));
        if (movedFrom) {
          vanished.delete(contentKey(unit.files));
          db.update(audiobooks).set({ relPath: unit.relPath }).where(eq(audiobooks.id, movedFrom.id)).run();
          await refresh(opts, movedFrom.id, unit, signature, report);
          raiseFromFolders(db, movedFrom.bookId, unit);
          report.moved++;
        } else {
          await addUnit(opts, unit, signature, report);
        }
      }
    } catch (err) {
      report.errors.push({ relPath: unit.relPath, error: err instanceof Error ? err.message : String(err) });
    }
    opts.onProgress?.(++done, units.length);
  }

  for (const row of db.select({ id: audiobooks.id, relPath: audiobooks.relPath }).from(audiobooks).all()) {
    if (onDisk.has(row.relPath)) continue;
    db.delete(audiobooks).where(eq(audiobooks.id, row.id)).run();
    report.removed++;
  }

  report.finishedAt = Date.now();
  return report;
}

/** Re-read a changed folder; the book link stays. */
async function refresh(opts: AudioScanOptions, id: string, unit: AudiobookUnit, signature: string, report: AudioScanReport) {
  const probed = await probeAudiobook(unit);
  for (const e of probed.errors) report.errors.push({ relPath: unit.relPath, error: e });
  opts.db
    .update(audiobooks)
    .set({
      signature,
      tracks: probed.tracks,
      chapters: probed.chapters,
      duration: probed.duration,
      narrator: probed.narrator,
      coverRelPath: unit.coverRelPath,
      updatedAt: Date.now(),
    })
    .where(eq(audiobooks.id, id))
    .run();
}

async function addUnit(opts: AudioScanOptions, unit: AudiobookUnit, signature: string, report: AudioScanReport) {
  const { db } = opts;
  const probed = await probeAudiobook(unit);
  for (const e of probed.errors) report.errors.push({ relPath: unit.relPath, error: e });
  if (!probed.tracks.length) return; // nothing playable; reported above

  const { metadata } = probed;
  const row = {
    relPath: unit.relPath,
    signature,
    tracks: probed.tracks,
    chapters: probed.chapters,
    duration: probed.duration,
    narrator: probed.narrator,
    coverRelPath: unit.coverRelPath,
    updatedAt: Date.now(),
  };

  const sameWork = findSameWork(db, metadata);
  if (sameWork) {
    db.insert(audiobooks).values({ ...row, bookId: sameWork.id }).run();
    raiseFromFolders(db, sameWork.id, unit);
    if (!sameWork.coverPath) await setCover(opts, sameWork.id, unit, probed.metadata.cover);
    report.linked++;
    return;
  }

  const title = metadata.title ?? unit.relPath.split("/").pop()!;
  const relPaths = unit.files.map((f) => f.relPath);
  const rating = autoRating({ relPaths, metadata });
  const bookId = db.transaction((tx) => {
    const [book] = tx
      .insert(books)
      .values({
        ...bookFieldsFrom({ ...metadata, title }),
        title,
        sortTitle: bookFieldsFrom({ title }).sortTitle!,
        rating: rating?.rating ?? null,
        ratingSource: rating?.source ?? null,
        approved: false,
      })
      .returning({ id: books.id })
      .all();
    tx.insert(audiobooks).values({ ...row, bookId: book!.id }).run();
    if (metadata.authors?.length) setBookAuthors(tx, book!.id, metadata.authors);
    if (metadata.series) setBookSeries(tx, book!.id, metadata.series, metadata.seriesPosition);
    addGenreTags(tx, book!.id, metadata.subjects);
    return book!.id;
  });
  report.added++;

  await setCover(opts, bookId, unit, metadata.cover);
  if (opts.online) {
    const res = await enrichBook({ db, configDir: opts.configDir, bookId, fileMetadata: metadata, lookup: opts.online });
    for (const e of res.errors) report.errors.push({ relPath: unit.relPath, error: `lookup: ${e}` });
    // enrichBook rates from ebook file paths only; put the audiobook's folder signals back.
    raiseFromFolders(db, bookId, unit, true);
  }
}

async function setCover(opts: AudioScanOptions, bookId: string, unit: AudiobookUnit, embedded: { data: Buffer; mime: string } | undefined) {
  const folderCover = unit.coverRelPath ? await readCoverFile(join(opts.audiobooksDir, unit.coverRelPath)) : undefined;
  const cover = folderCover ?? embedded;
  if (!cover) return;
  const coverPath = await saveCover(opts.configDir, bookId, cover).catch(() => undefined);
  if (coverPath) opts.db.update(books).set({ coverPath }).where(eq(books.id, bookId)).run();
}

/**
 * Folder signals ("kids/", "adult/") from the audiobook's path. Like the library's rule, they
 * may only make an approved book more restrictive. `inbox` = treat an inbox book as approved
 * too, so a lookup can't lower what its folder said before an admin looks at it.
 */
function raiseFromFolders(db: Db, bookId: string, unit: AudiobookUnit, inbox = false) {
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book || (!book.approved && !inbox)) return;
  const signal = autoRating({ relPaths: unit.files.map((f) => f.relPath), metadata: {} });
  if (signal && shouldReplaceRating({ ...book, approved: true }, signal)) {
    db.update(books).set({ rating: signal.rating, ratingSource: signal.source, updatedAt: Date.now() }).where(eq(books.id, bookId)).run();
  }
}
