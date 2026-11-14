/**
 * Kindle library import (admin-only). Turns a CSV export of a Kindle library into metadata-only
 * `kindle_only` books with the ASIN, so they show up in the library and Discover with a
 * "Read in Kindle" link. Nothing is downloaded and no DRM is touched (CLAUDE.md rule 5).
 *
 * Accepted columns (case-insensitive, any order, extra columns ignored):
 *   ASIN | Product ID          Title | Product Name | Book Title
 *   Author | Authors | Author(s) | Creator          ISBN (optional)
 * That covers Amazon's "Digital Items" order export, Kindle library exporter extensions,
 * and a hand-made spreadsheet.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { CONTENT_RATINGS, isAsin } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import { requireAdmin } from "../auth/plugin.js";
import { toIsbn13 } from "../metadata/isbn.js";
import { authorDisplayName, collapse, sortTitle } from "../metadata/text.js";
import { findSameWork, setBookAuthors } from "../library/store.js";

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF, a leading BOM, `,` `;` or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const blank = (r: string[]) => r.every((f) => f.trim() === "");

const COLUMNS = {
  asin: ["asin", "product id", "kindle asin", "asin/isbn"],
  title: ["title", "product name", "book title", "name"],
  author: ["author", "authors", "author(s)", "creator", "author name", "contributors"],
  isbn: ["isbn", "isbn13", "isbn-13"],
} as const;

export interface KindleRow {
  line: number;
  asin: string | null;
  title: string;
  authors: string[];
  isbn13: string | null;
}

/** Amazon titles often carry the store's decorations; keep the book's own title. */
export function cleanTitle(raw: string): string {
  return collapse(
    raw
      .replace(/\s*[:-]?\s*\(?(kindle edition|ebook)\)?\s*$/i, "")
      .replace(/\s+ebook\s*:.*$/i, "")
      .replace(/\s*\[[^\]]*kindle[^\]]*\]\s*$/i, ""),
  );
}

export function splitAuthors(raw: string): string[] {
  const parts = raw
    .split(/\s*(?:;|&|\band\b|\|)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
  // "Sanderson, Brandon" is one person; "A, B, C" with no ; or & is a list.
  const flat = parts.flatMap((p) => (p.split(",").length > 2 ? p.split(",") : [p]));
  return [...new Set(flat.map((a) => authorDisplayName(a)).filter(Boolean))].slice(0, 10);
}

export function readKindleCsv(text: string): { rows: KindleRow[]; errors: string[] } {
  const table = parseCsv(text);
  const errors: string[] = [];
  while (table.length && blank(table[0]!)) table.shift();
  if (!table.length) return { rows: [], errors: ["The file is empty"] };
  const header = table[0]!.map((h) => collapse(h).toLowerCase());
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const idx = { asin: col(COLUMNS.asin), title: col(COLUMNS.title), author: col(COLUMNS.author), isbn: col(COLUMNS.isbn) };
  if (idx.title < 0) return { rows: [], errors: ['No "Title" column found in the first row'] };

  const rows: KindleRow[] = [];
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (blank(r)) return;
    const get = (k: number) => (k >= 0 ? (r[k] ?? "").trim() : "");
    const title = cleanTitle(get(idx.title));
    if (!title) {
      errors.push(`Line ${line}: no title`);
      return;
    }
    const asinRaw = get(idx.asin).toUpperCase();
    if (asinRaw && !isAsin(asinRaw)) errors.push(`Line ${line}: "${asinRaw}" isn't an ASIN, imported without one`);
    rows.push({
      line,
      asin: asinRaw && isAsin(asinRaw) ? asinRaw : null,
      title,
      authors: splitAuthors(get(idx.author)),
      isbn13: toIsbn13(get(idx.isbn)) ?? null,
    });
  });
  return { rows, errors };
}

export interface ImportReport {
  created: number;
  /** Existing books (a file you own, or an earlier import) that got the ASIN added. */
  linked: number;
  /** Already imported with the same ASIN. */
  skipped: number;
  errors: string[];
  bookIds: string[];
}

export function importKindleRows(
  db: Db,
  rows: KindleRow[],
  opts: { rating?: (typeof CONTENT_RATINGS)[number]; dryRun?: boolean } = {},
): ImportReport {
  const report: ImportReport = { created: 0, linked: 0, skipped: 0, errors: [], bookIds: [] };
  const run = () => {
    db.transaction((tx) => {
      for (const row of rows) {
        if (row.asin && tx.select({ id: books.id }).from(books).where(eq(books.kindleAsin, row.asin)).get()) {
          report.skipped++;
          continue;
        }
        const same = findSameWork(tx, { title: row.title, authors: row.authors, isbn13: row.isbn13 ?? undefined });
        if (same) {
          if (same.kindleAsin || !row.asin) report.skipped++;
          else {
            tx.update(books)
              .set({ kindleAsin: row.asin, updatedAt: Date.now() })
              .where(and(eq(books.id, same.id), isNull(books.kindleAsin)))
              .run();
            report.linked++;
            report.bookIds.push(same.id);
          }
          continue;
        }
        const [book] = tx
          .insert(books)
          .values({
            title: row.title,
            sortTitle: sortTitle(row.title),
            isbn13: row.isbn13,
            kindleOnly: true,
            kindleAsin: row.asin,
            // An admin imported it, so it skips the inbox. Unrated still means adult-only
            // until someone rates it (fail closed).
            approved: true,
            rating: opts.rating ?? null,
            ratingSource: opts.rating ? "admin" : null,
            updatedAt: Date.now(),
          })
          .returning({ id: books.id })
          .all();
        if (row.authors.length) setBookAuthors(tx, book!.id, row.authors);
        report.created++;
        report.bookIds.push(book!.id);
      }
      if (opts.dryRun) tx.rollback();
    });
  };
  try {
    run();
  } catch (e) {
    // Drizzle signals rollback with an error; a dry run ends that way on purpose.
    if (!opts.dryRun) throw e;
  }
  return report;
}

const ImportBody = z.object({
  csv: z.string().min(1).max(10_000_000),
  /** Rating for every new entry; leave empty to rate them later (they stay adult-only meanwhile). */
  rating: z.enum(CONTENT_RATINGS).optional(),
  /** Count what would happen without saving anything. */
  dryRun: z.boolean().default(false),
});

export async function kindleRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/api/admin/kindle/import", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    requireAdmin(req);
    const body = ImportBody.parse(req.body);
    const { rows, errors } = readKindleCsv(body.csv);
    const report = importKindleRows(db, rows, { rating: body.rating, dryRun: body.dryRun });
    return { ...report, rows: rows.length, errors: [...errors, ...report.errors], dryRun: body.dryRun };
  });
}
