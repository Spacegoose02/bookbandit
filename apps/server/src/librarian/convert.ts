/**
 * Format conversion on the job runner.
 *
 * - `librarian.convert`: MOBI/AZW3/FB2/TXT → EPUB with Calibre's `ebook-convert`. The EPUB goes
 *   next to the original under BOOKS_DIR and is attached to the same book right away, so a rescan
 *   sees a known file. The original is never touched. DRM files are refused (CLAUDE.md rule 5).
 * - `librarian.kepub`: EPUB → KEPUB ahead of time with kepubify, into the same cache the Kobo
 *   download route reads (CONFIG_DIR/cache/kepub), so a Kobo sync never waits on a conversion.
 * - `librarian.writeMetadata`: writes the book's details into its EPUB files (off by default).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookFiles, books } from "../db/schema.js";
import { PermanentJobError, type JobRunner } from "../jobs/index.js";
import { isDrmProtected } from "../library/drm.js";
import { sha256File } from "../library/hash.js";
import { insideRoot } from "../library/serve.js";
import type { BookFormat } from "../library/formats.js";
import type { KepubConverter } from "../kobo/kepub.js";
import { describeBooks, loadBooks } from "./books.js";
import { writeEpubMetadata } from "./epub-write.js";

export const CONVERT_JOB = "librarian.convert";
export const KEPUB_JOB = "librarian.kepub";
export const WRITE_METADATA_JOB = "librarian.writeMetadata";

/** Formats ebook-convert turns into a good EPUB, best source first. PDF and comics convert badly, so they're left alone. */
export const CONVERTIBLE: readonly BookFormat[] = ["azw3", "mobi", "fb2", "txt"];

/** Runs the converter: writes `output` from `input`, or throws. Tests pass a fake. */
export type ConvertFn = (input: string, output: string, signal: AbortSignal) => Promise<void>;

export function ebookConvert(bin: string): ConvertFn {
  return (input, output, signal) =>
    new Promise((resolve, reject) => {
      execFile(bin, [input, output], { timeout: 15 * 60_000, signal, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
        if (err) reject(new Error(`ebook-convert failed: ${(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`));
        else resolve();
      });
    });
}

/** Whether a command runs here (checked once per path). */
const availability = new Map<string, Promise<boolean>>();
export function commandAvailable(bin: string, args = ["--version"]): Promise<boolean> {
  let p = availability.get(bin);
  if (!p) {
    p = new Promise((resolve) => execFile(bin, args, { timeout: 15_000 }, (err) => resolve(!err)));
    availability.set(bin, p);
  }
  return p;
}

export interface ConvertPayload {
  bookId: string;
  fileId: string;
  to: "epub";
}

export interface KepubPayload {
  /** Only these books; all books with an EPUB when missing. */
  bookIds?: string[];
}

export interface WriteMetadataPayload {
  bookId: string;
}

export interface ConvertDeps {
  db: Db;
  booksRoot: string;
  convert: ConvertFn;
  kepub: KepubConverter;
}

/** Where the EPUB for `relPath` goes: same folder and name, ".epub"; a suffix if that's taken. */
export async function outputPath(booksRoot: string, relPath: string, db: Db): Promise<string> {
  const dir = dirname(relPath);
  const base = basename(relPath, extname(relPath));
  for (let i = 0; i < 50; i++) {
    const name = `${base}${i === 0 ? "" : i === 1 ? " (converted)" : ` (converted ${i})`}.epub`;
    const rel = dir === "." ? name : `${dir}/${name}`;
    const abs = insideRoot(booksRoot, rel);
    if (!abs) throw new PermanentJobError("Bad path");
    const taken = (await stat(abs).then(() => true, () => false)) || !!db.select({ id: bookFiles.id }).from(bookFiles).where(eq(bookFiles.relPath, rel)).get();
    if (!taken) return rel;
  }
  throw new PermanentJobError("No free file name for the EPUB");
}

/** The file to convert for a book: the best convertible format, unless it already has an EPUB. */
export function pickSource(files: { id: string; format: string }[], force = false): { id: string; format: string } | "has_epub" | "nothing" {
  if (!force && files.some((f) => f.format === "epub" || f.format === "kepub")) return "has_epub";
  for (const fmt of CONVERTIBLE) {
    const f = files.find((x) => x.format === fmt);
    if (f) return f;
  }
  return "nothing";
}

export function registerConvertJobs(runner: JobRunner, deps: ConvertDeps): void {
  const { db, booksRoot } = deps;

  runner.register<ConvertPayload>(
    CONVERT_JOB,
    async (p, ctx) => {
      const file = db.select().from(bookFiles).where(and(eq(bookFiles.id, p.fileId), eq(bookFiles.bookId, p.bookId))).get();
      if (!file) throw new PermanentJobError("That file is no longer in the library");
      const abs = insideRoot(booksRoot, file.relPath);
      if (!abs || !(await stat(abs).then((s) => s.isFile(), () => false))) throw new PermanentJobError(`File is missing on disk: ${file.relPath}`);
      if (await isDrmProtected(abs, file.format)) throw new PermanentJobError("This file is DRM-protected; Bookbandit never converts DRM files");

      const rel = await outputPath(booksRoot, file.relPath, db);
      const outAbs = insideRoot(booksRoot, rel)!;
      // Hidden temp file in the same folder: scans skip it and the rename is atomic.
      const tmp = join(dirname(outAbs), `.bb-convert-${randomBytes(6).toString("hex")}.epub`);
      ctx.log(`Converting ${file.relPath} to EPUB`);
      ctx.progress(0.1);
      try {
        await deps.convert(abs, tmp, ctx.signal);
        const s = await stat(tmp).catch(() => undefined);
        if (!s?.size) throw new Error("ebook-convert made no file");
        await rename(tmp, outAbs);
      } finally {
        await rm(tmp, { force: true });
      }
      const info = await stat(outAbs);
      const sha256 = await sha256File(outAbs);
      const stillThere = db.select({ id: books.id }).from(books).where(eq(books.id, p.bookId)).get();
      if (!stillThere) {
        // The book was merged or removed meanwhile; leave the file for the next scan to pick up.
        ctx.log(`Book is gone; ${rel} will be picked up by the next scan`, "warn");
        return { relPath: rel };
      }
      const [row] = db
        .insert(bookFiles)
        .values({ bookId: p.bookId, relPath: rel, format: "epub", sizeBytes: info.size, mtimeMs: Math.floor(info.mtimeMs), sha256 })
        .returning({ id: bookFiles.id })
        .all();
      db.update(books).set({ updatedAt: Date.now() }).where(eq(books.id, p.bookId)).run();
      ctx.log(`Saved ${rel}`);
      ctx.progress(1);
      return { relPath: rel, fileId: row!.id };
    },
    { maxAttempts: 2 },
  );

  runner.register<KepubPayload>(
    KEPUB_JOB,
    async (p, ctx) => {
      if (!(await deps.kepub.isAvailable())) throw new PermanentJobError("kepubify isn't installed here (it is in the Docker image)");
      const where = p.bookIds?.length
        ? and(inArray(bookFiles.bookId, p.bookIds), eq(bookFiles.format, "epub"))
        : eq(bookFiles.format, "epub");
      const files = db.select().from(bookFiles).where(where).orderBy(asc(bookFiles.relPath)).all();
      let done = 0;
      let converted = 0;
      let failed = 0;
      for (const f of files) {
        if (ctx.signal.aborted) break;
        const abs = insideRoot(booksRoot, f.relPath);
        const info = abs ? await stat(abs).catch(() => undefined) : undefined;
        if (abs && info?.isFile() && !(await isDrmProtected(abs, f.format))) {
          const out = await deps.kepub.convert(abs, { id: f.id, sizeBytes: info.size, mtimeMs: info.mtimeMs });
          if (out) converted++;
          else {
            failed++;
            ctx.log(`kepubify failed for ${f.relPath}`, "warn");
          }
        }
        ctx.progress(++done / files.length);
      }
      ctx.log(`${converted} ready for Kobo${failed ? `, ${failed} failed` : ""}`);
      return { files: files.length, converted, failed };
    },
    { maxAttempts: 1 },
  );

  runner.register<WriteMetadataPayload>(
    WRITE_METADATA_JOB,
    async (p, ctx) => {
      const [book] = describeBooks(db, loadBooks(db, [p.bookId]));
      if (!book) throw new PermanentJobError("That book is no longer in the library");
      const epubs = book.files.filter((f) => f.format === "epub" || f.format === "kepub");
      if (!epubs.length) throw new PermanentJobError("This book has no EPUB file");
      let written = 0;
      for (const f of epubs) {
        const abs = insideRoot(booksRoot, f.relPath);
        if (!abs || !(await stat(abs).then((s) => s.isFile(), () => false))) {
          ctx.log(`Missing on disk: ${f.relPath}`, "warn");
          continue;
        }
        if (await isDrmProtected(abs, f.format as BookFormat)) {
          ctx.log(`Skipped DRM-protected ${f.relPath}`, "warn");
          continue;
        }
        await writeEpubMetadata(abs, {
          title: book.title,
          authors: book.authors,
          language: book.language,
          description: book.description,
          publisher: book.publisher,
          isbn13: book.isbn13,
          series: book.series ? { name: book.series.name, position: book.series.position } : null,
        });
        // Keep the row in step so the next scan sees an unchanged file, not a new one.
        const info = await stat(abs);
        db.update(bookFiles)
          .set({ sizeBytes: info.size, mtimeMs: Math.floor(info.mtimeMs), sha256: await sha256File(abs) })
          .where(eq(bookFiles.id, f.id))
          .run();
        ctx.log(`Wrote details into ${f.relPath}`);
        written++;
      }
      return { written };
    },
    { maxAttempts: 1 },
  );
}

/** Books that have a convertible file and no EPUB yet. */
export function needsConversionCount(db: Db): number {
  const list = sql.join(
    CONVERTIBLE.map((f) => sql`${f}`),
    sql`, `,
  );
  return (
    db
      .select({ n: sql<number>`count(distinct ${bookFiles.bookId})` })
      .from(bookFiles)
      .where(
        sql`${bookFiles.format} in (${list}) and not exists (select 1 from ${bookFiles} e where e.book_id = ${bookFiles.bookId} and e.format in ('epub', 'kepub'))`,
      )
      .get()?.n ?? 0
  );
}
