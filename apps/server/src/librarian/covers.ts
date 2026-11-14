/**
 * Cover editor helpers: candidates (the book's own files, online lookup results) and saving a
 * new cover from a URL, a file inside the book, or an uploaded/cropped image.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookFiles, books } from "../db/schema.js";
import { downloadCover, saveCover } from "../library/covers.js";
import { insideRoot } from "../library/serve.js";
import type { BookFormat } from "../library/formats.js";
import { extractMetadata } from "../metadata/extract.js";
import { lookupOnline, type LookupOptions } from "../metadata/lookup.js";
import type { Cover } from "../metadata/types.js";
import type { LibrarianBook } from "./books.js";

export interface CoverCandidate {
  source: "file" | "openlibrary" | "google" | "hardcover" | "isbndb";
  label: string;
  /** For "file": the admin endpoint that streams it. Otherwise the provider's image URL. */
  url: string;
  fileId?: string;
}

const COVER_FORMATS: BookFormat[] = ["epub", "kepub", "cbz"];

/** Sniffs the image type from its first bytes; null when it isn't one we keep. */
export function imageMime(data: Buffer): string | null {
  if (data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return null;
}

export async function coverFromFile(booksRoot: string, file: { relPath: string; format: BookFormat; sizeBytes: number }): Promise<Cover | undefined> {
  if (!COVER_FORMATS.includes(file.format)) return undefined;
  const abs = insideRoot(booksRoot, file.relPath);
  if (!abs) return undefined;
  const { metadata } = await extractMetadata({ absPath: abs, relPath: file.relPath, format: file.format, sizeBytes: file.sizeBytes });
  return metadata.cover;
}

export async function coverCandidates(book: LibrarianBook, lookup: LookupOptions | false): Promise<{ candidates: CoverCandidate[]; errors: string[] }> {
  const candidates: CoverCandidate[] = [];
  for (const f of book.files) {
    if (COVER_FORMATS.includes(f.format as BookFormat)) {
      candidates.push({
        source: "file",
        label: `From ${f.relPath.split("/").pop()}`,
        url: `/api/admin/librarian/books/${encodeURIComponent(book.id)}/covers/file/${encodeURIComponent(f.id)}`,
        fileId: f.id,
      });
    }
  }
  const errors: string[] = [];
  if (lookup) {
    const res = await lookupOnline({ title: book.title, authors: book.authors, isbn13: book.isbn13 ?? undefined }, lookup);
    errors.push(...res.errors);
    const seen = new Set<string>();
    for (const m of res.matches) {
      if (!m.coverUrl || seen.has(m.coverUrl)) continue;
      seen.add(m.coverUrl);
      candidates.push({ source: m.provider, label: PROVIDER_LABEL[m.provider], url: m.coverUrl });
    }
    if (book.isbn13) {
      const url = `https://covers.openlibrary.org/b/isbn/${book.isbn13}-L.jpg?default=false`;
      if (!seen.has(url)) candidates.push({ source: "openlibrary", label: "Open Library (by ISBN)", url });
    }
  }
  return { candidates, errors };
}

const PROVIDER_LABEL = { openlibrary: "Open Library", google: "Google Books", hardcover: "Hardcover", isbndb: "ISBNdb" } as const;

export async function fetchCoverUrl(fetchFn: typeof fetch, url: string): Promise<Cover | undefined> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  return downloadCover(fetchFn, u.toString());
}

/** Saves the cover and points the book at it, removing an old cover with another extension. */
export async function setBookCover(db: Db, configDir: string, bookId: string, cover: Cover): Promise<string | undefined> {
  const before = db.select({ coverPath: books.coverPath }).from(books).where(eq(books.id, bookId)).get();
  const rel = await saveCover(configDir, bookId, cover);
  if (!rel) return undefined;
  if (before?.coverPath && before.coverPath !== rel) {
    const old = insideRoot(resolve(configDir), before.coverPath);
    if (old && before.coverPath.startsWith("covers/")) await rm(old, { force: true });
  }
  db.update(books).set({ coverPath: rel, updatedAt: Date.now() }).where(eq(books.id, bookId)).run();
  return rel;
}

export function fileOfBook(db: Db, bookId: string, fileId: string) {
  return db
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.id, fileId))
    .all()
    .find((f) => f.bookId === bookId);
}

