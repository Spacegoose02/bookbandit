/**
 * Google Play Books library → metadata-only entries, like the Kindle import. Nothing is
 * downloaded and no DRM is touched (CLAUDE.md rule 5): the book page links to Google Play.
 *
 * Accepts
 * - a CSV with a Title column and any of Author(s), ISBN, Volume ID / ID / Google ID, or a
 *   column of play.google.com links (a hand-made list or a library exporter);
 * - JSON from the Google Books API "My Library" bookshelves (`{ items: [{ id, volumeInfo }] }`)
 *   or a plain array of `{ title, authors, isbn, volumeId }`.
 */
import { eq } from "drizzle-orm";
import { CONTENT_RATINGS, type ContentRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import { parseCsv, splitAuthors } from "../discover/kindle.js";
import { findSameWork, setBookAuthors } from "../library/store.js";
import { toIsbn13 } from "../metadata/isbn.js";
import { collapse, sortTitle, yearFrom } from "../metadata/text.js";
import { bookByIdentifier, setIdentifier, writeOrRollBack, type Reporter } from "./common.js";

export interface PlayRow {
  title: string;
  authors: string[];
  isbn13: string | null;
  volumeId: string | null;
  publishedYear: number | null;
}

const VOLUME_ID = /^[A-Za-z0-9_-]{12}$/;

/** The volume id from a raw id or a play.google.com / books.google.com link. */
export function volumeIdFrom(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (VOLUME_ID.test(s)) return s;
  const m = s.match(/[?&]id=([A-Za-z0-9_-]{12})\b/);
  return m ? m[1]! : null;
}

export const playBooksUrl = (volumeId: string) => `https://play.google.com/store/books/details?id=${encodeURIComponent(volumeId)}`;

export function readPlayLibrary(text: string): { rows: PlayRow[]; errors: string[] } {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return { rows: [], errors: ["The file is empty"] };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return readJson(trimmed);
  const table = parseCsv(trimmed).filter((r) => r.some((f) => f.trim()));
  const header = (table[0] ?? []).map((h) => collapse(h).toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const idx = {
    title: col("title", "book title", "name"),
    author: col("author", "authors", "author(s)", "creator"),
    isbn: col("isbn", "isbn13", "isbn-13"),
    id: col("volume id", "volumeid", "id", "google id", "google books id"),
    link: col("link", "url", "play link", "play books link"),
    year: col("published", "published date", "year"),
  };
  if (idx.title < 0) return { rows: [], errors: ['No "Title" column found in the first row'] };
  const errors: string[] = [];
  const rows: PlayRow[] = [];
  table.slice(1).forEach((r, i) => {
    const get = (k: number) => (k >= 0 ? (r[k] ?? "").trim() : "");
    const title = collapse(get(idx.title));
    if (!title) {
      errors.push(`Line ${i + 2}: no title`);
      return;
    }
    rows.push({
      title,
      authors: splitAuthors(get(idx.author)),
      isbn13: toIsbn13(get(idx.isbn)) ?? null,
      volumeId: volumeIdFrom(get(idx.id)) ?? volumeIdFrom(get(idx.link)),
      publishedYear: yearFrom(get(idx.year)) ?? null,
    });
  });
  return { rows, errors };
}

function readJson(text: string): { rows: PlayRow[]; errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { rows: [], errors: ["That isn't valid JSON"] };
  }
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown[] })?.items) ? (data as { items: unknown[] }).items : [];
  const rows: PlayRow[] = [];
  const errors: string[] = [];
  list.forEach((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const info = (o.volumeInfo ?? o) as Record<string, unknown>;
    const title = typeof info.title === "string" ? collapse(info.title) : "";
    if (!title) {
      errors.push(`Item ${i + 1}: no title`);
      return;
    }
    const authors = Array.isArray(info.authors) ? (info.authors as unknown[]).filter((a): a is string => typeof a === "string") : typeof info.author === "string" ? splitAuthors(info.author) : [];
    const ids = Array.isArray(info.industryIdentifiers) ? (info.industryIdentifiers as { identifier?: string }[]) : [];
    const isbn = ids.map((x) => toIsbn13(x.identifier)).find(Boolean) ?? toIsbn13(typeof info.isbn === "string" ? info.isbn : undefined);
    rows.push({
      title,
      authors: authors.map(collapse).filter(Boolean).slice(0, 10),
      isbn13: isbn ?? null,
      volumeId: volumeIdFrom(typeof o.id === "string" ? o.id : typeof o.volumeId === "string" ? o.volumeId : undefined),
      publishedYear: yearFrom(typeof info.publishedDate === "string" ? info.publishedDate : undefined) ?? null,
    });
  });
  if (!rows.length && !errors.length) errors.push("No books found in the file");
  return { rows, errors };
}

export async function importGooglePlay(
  db: Db,
  rows: PlayRow[],
  opts: { dryRun: boolean; rating?: ContentRating },
  report: Reporter,
): Promise<void> {
  if (opts.rating && !CONTENT_RATINGS.includes(opts.rating)) throw new Error("Unknown age group");
  await writeOrRollBack(db, opts.dryRun, (tx) => {
    for (const row of rows) {
      const label = row.authors.length ? `${row.title} — ${row.authors[0]}` : row.title;
      const already = row.volumeId ? bookByIdentifier(tx, "google-play", row.volumeId) : undefined;
      if (already) {
        report.add("skipped", label, "Already imported");
        continue;
      }
      const same = findSameWork(tx, { title: row.title, authors: row.authors, isbn13: row.isbn13 ?? undefined });
      if (same) {
        if (row.volumeId) {
          setIdentifier(tx, same.id, "google-play", row.volumeId);
          if (!same.googleBooksId) tx.update(books).set({ googleBooksId: row.volumeId, updatedAt: Date.now() }).where(eq(books.id, same.id)).run();
          report.add("matched", label, "Already in the library; added the Google Play link");
        } else report.add("skipped", label, "Already in the library");
        continue;
      }
      const book = tx
        .insert(books)
        .values({
          title: row.title,
          sortTitle: sortTitle(row.title),
          isbn13: row.isbn13,
          publishedYear: row.publishedYear,
          googleBooksId: row.volumeId,
          // An admin imported it, so it skips the inbox. Unrated stays adult-only until rated.
          approved: true,
          rating: opts.rating ?? null,
          ratingSource: opts.rating ? "admin" : null,
          updatedAt: Date.now(),
        })
        .returning({ id: books.id })
        .get();
      if (row.authors.length) setBookAuthors(tx, book.id, row.authors);
      setIdentifier(tx, book.id, "google-play", row.volumeId ?? `title:${row.title.toLowerCase()}`);
      report.add("new", label, row.volumeId ? "On Google Play Books" : "On Google Play Books (no volume id, so no direct link)");
    }
  });
}
