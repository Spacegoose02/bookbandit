/**
 * Goodreads and StoryGraph CSV exports → one person's reading history, and back out again in
 * Goodreads' format (which StoryGraph and most other sites import too).
 *
 * Every row is kept as history, even for books the family doesn't own. Rows that match a library
 * book (Goodreads id from Calibre's identifiers, ISBN, or title and author) can also mark it
 * finished, go on a "Want to read" collection, and land in collections named after the shelves.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Reader } from "../auth/reader.js";
import type { Db } from "../db/client.js";
import { books, readingProgress } from "../db/schema.js";
import { visibleBooksWhere } from "../content/lock.js";
import { parseCsv } from "../discover/kindle.js";
import { findSameWork } from "../library/store.js";
import { toIsbn13 } from "../metadata/isbn.js";
import { authorDisplayName, collapse } from "../metadata/text.js";
import {
  addToCollection,
  authorsOf,
  bookByIdentifier,
  ensureCollection,
  importProgress,
  parseDate,
  person,
  slashDate,
  upsertHistory,
  writeOrRollBack,
  type Reporter,
  type Tx,
} from "./common.js";
import { bookIdentifiers, readingHistory, type ReadingStatus } from "./schema.js";

export interface HistoryCsvRow {
  line: number;
  sourceKey: string;
  goodreadsId: string | null;
  title: string;
  authors: string[];
  isbn13: string | null;
  status: ReadingStatus;
  stars: number | null;
  review: string | null;
  shelves: string[];
  readCount: number;
  startedAt: number | null;
  finishedAt: number | null;
  addedAt: number | null;
}

export type CsvFlavor = "goodreads" | "storygraph";

/** Goodreads wraps ISBNs as ="0441013597" so spreadsheets keep the leading zero. */
function cleanIsbn(raw: string): string | null {
  return toIsbn13(raw.replace(/^="?|"$/g, "")) ?? null;
}

function statusFrom(raw: string): { status: ReadingStatus; known: boolean } {
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (s === "read") return { status: "read", known: true };
  if (s === "currently-reading" || s === "reading") return { status: "reading", known: true };
  if (s === "to-read" || s === "want-to-read") return { status: "to-read", known: true };
  if (/^(did-not-finish|dnf|abandoned|gave-up)/.test(s)) return { status: "did-not-finish", known: true };
  return { status: "to-read", known: false };
}

const splitList = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function readHistoryCsv(text: string): { flavor: CsvFlavor; rows: HistoryCsvRow[]; errors: string[] } {
  const table = parseCsv(text).filter((r) => r.some((f) => f.trim() !== ""));
  if (!table.length) return { flavor: "goodreads", rows: [], errors: ["The file is empty"] };
  const header = table[0]!.map((h) => collapse(h).toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const flavor: CsvFlavor = col("read status") >= 0 && col("exclusive shelf") < 0 ? "storygraph" : "goodreads";
  const idx = {
    id: col("book id"),
    title: col("title"),
    author: col("author", "authors"),
    additional: col("additional authors"),
    isbn: col("isbn"),
    isbn13: col("isbn13", "isbn/uid"),
    stars: col("my rating", "star rating"),
    dateRead: col("date read", "last date read"),
    datesRead: col("dates read"),
    dateAdded: col("date added"),
    shelves: col("bookshelves", "tags"),
    exclusive: col("exclusive shelf", "read status"),
    review: col("my review", "review"),
    readCount: col("read count"),
  };
  if (idx.title < 0) return { flavor, rows: [], errors: ['No "Title" column found in the first row'] };
  const errors: string[] = [];
  const rows: HistoryCsvRow[] = [];
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k: number) => (k >= 0 ? (r[k] ?? "").trim() : "");
    const title = collapse(get(idx.title));
    if (!title) {
      errors.push(`Line ${line}: no title`);
      return;
    }
    const authors = [
      ...(flavor === "storygraph" ? splitList(get(idx.author)) : [get(idx.author)]),
      ...splitList(get(idx.additional)),
    ]
      .map((a) => authorDisplayName(a))
      .filter(Boolean);
    const isbn13 = cleanIsbn(get(idx.isbn13)) ?? cleanIsbn(get(idx.isbn));
    const exclusive = get(idx.exclusive) || "to-read";
    const { status, known } = statusFrom(exclusive);
    const shelfNames = splitList(get(idx.shelves)).filter((s) => s.toLowerCase() !== exclusive.toLowerCase());
    if (!known) shelfNames.unshift(exclusive);
    const starsRaw = Number(get(idx.stars));
    const stars = Number.isFinite(starsRaw) && starsRaw > 0 ? Math.min(5, Math.round(starsRaw * 4) / 4) : null;
    // StoryGraph: "2023/01/02-2023/01/10, 2021/05/01-2021/05/09"; the last range is the latest read.
    let startedAt: number | null = null;
    let finishedAt = parseDate(get(idx.dateRead));
    const ranges = get(idx.datesRead);
    if (ranges) {
      const last = ranges.split(",").map((s) => s.trim()).filter(Boolean).pop() ?? "";
      const [a, b] = last.split("-").map((s) => s.trim());
      startedAt = parseDate(a);
      finishedAt = parseDate(b) ?? finishedAt;
    }
    const readCountRaw = Number(get(idx.readCount));
    const goodreadsId = flavor === "goodreads" && /^\d+$/.test(get(idx.id)) ? get(idx.id) : null;
    rows.push({
      line,
      sourceKey: goodreadsId ?? isbn13 ?? `${title.toLowerCase()}|${(authors[0] ?? "").toLowerCase()}`,
      goodreadsId,
      title,
      authors,
      isbn13,
      status,
      stars,
      review: get(idx.review).replace(/<br\s*\/?>/gi, "\n") || null,
      shelves: shelfNames,
      readCount: Number.isFinite(readCountRaw) && readCountRaw > 0 ? readCountRaw : status === "read" ? 1 : 0,
      startedAt,
      finishedAt: status === "read" ? finishedAt : null,
      addedAt: parseDate(get(idx.dateAdded)),
    });
  });
  return { flavor, rows, errors };
}

export interface HistoryImportOptions {
  userId: string;
  /** Mark matched "read" books finished in Bookbandit (newest wins). */
  markFinished: boolean;
  /** Put matched "to-read" books on the person's "Want to read" collection. */
  wantToRead: boolean;
  /** Put matched books in the person's collections named after their other shelves. */
  shelves: boolean;
}

export function matchHistoryRow(tx: Tx, row: { goodreadsId?: string | null; isbn13: string | null; title: string; authors: string[] }): string | undefined {
  if (row.goodreadsId) {
    const id = bookByIdentifier(tx, "goodreads", row.goodreadsId);
    if (id) return id;
  }
  // Goodreads adds the series to the title: "Mistborn: The Final Empire (Mistborn, #1)".
  const title = row.title.replace(/\s*\([^()]*#\s*\d+(?:\.\d+)?\)\s*$/, "") || row.title;
  return findSameWork(tx, { title, authors: row.authors, isbn13: row.isbn13 ?? undefined })?.id;
}

export async function importHistory(
  db: Db,
  flavor: CsvFlavor,
  rows: HistoryCsvRow[],
  opts: HistoryImportOptions & { dryRun: boolean },
  report: Reporter,
): Promise<void> {
  await writeOrRollBack(db, opts.dryRun, (tx) => {
    const owner = person(tx, opts.userId);
    if (!owner) throw new Error("That person doesn't exist");
    for (const row of rows) {
      const bookId = matchHistoryRow(tx, row) ?? null;
      const label = row.authors.length ? `${row.title} — ${row.authors[0]}` : row.title;
      const res = upsertHistory(tx, {
        userId: owner.id,
        bookId,
        title: row.title,
        author: row.authors.join(", ") || null,
        isbn13: row.isbn13,
        status: row.status,
        stars: row.stars,
        review: row.review,
        shelves: row.shelves,
        readCount: row.readCount,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        addedAt: row.addedAt,
        source: flavor,
        sourceKey: row.sourceKey,
      });
      const notes: string[] = [];
      let conflict = false;
      if (bookId) {
        if (row.status === "read" && opts.markFinished) {
          const p = importProgress(tx, owner.id, bookId, {
            percent: 1,
            finished: true,
            at: row.finishedAt ?? row.addedAt ?? 0,
            deviceName: flavor === "goodreads" ? "Goodreads" : "StoryGraph",
          });
          if (p === "written") notes.push("marked finished");
          if (p === "kept-newer") {
            conflict = true;
            notes.push("Bookbandit has newer progress; kept it");
          }
        }
        if (row.status === "to-read" && opts.wantToRead) {
          if (addToCollection(tx, ensureCollection(tx, owner.householdId, owner.id, "Want to read", report), bookId)) notes.push('on "Want to read"');
        }
        if (opts.shelves) {
          for (const shelf of row.shelves) {
            if (addToCollection(tx, ensureCollection(tx, owner.householdId, owner.id, shelf, report), bookId)) report.stat("books put in collections");
          }
        }
      }
      const where = bookId ? "in the library" : "history only (not in the library)";
      if (conflict) report.add("conflict", label, notes.join("; "));
      else if (res === "unchanged" && !notes.length) report.add("skipped", label, "Already imported");
      else report.add(bookId ? "matched" : "new", label, [`${row.status}${row.stars ? `, ${row.stars}★` : ""}`, where, ...notes].join("; "));
      if (bookId) report.stat("in the library");
    }
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const GOODREADS_HEADER = [
  "Book Id", "Title", "Author", "Author l-f", "Additional Authors", "ISBN", "ISBN13", "My Rating", "Average Rating",
  "Publisher", "Binding", "Number of Pages", "Year Published", "Original Publication Year", "Date Read", "Date Added",
  "Bookshelves", "Bookshelves with positions", "Exclusive Shelf", "My Review", "Spoiler", "Private Notes", "Read Count",
  "Owned Copies",
];

const csvField = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const EXCLUSIVE: Record<ReadingStatus, string> = { read: "read", reading: "currently-reading", "to-read": "to-read", "did-not-finish": "did-not-finish" };

function lastFirst(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts.pop()!;
  return `${last}, ${parts.join(" ")}`;
}

/**
 * A person's history as a Goodreads CSV: imported history plus books finished in Bookbandit that
 * have none. Rows linked to a book the reader can't see (content lock) are left out; standalone
 * rows (books the family doesn't own) are the reader's own records and stay, except for kids,
 * who only get rows for books they can see.
 */
export function exportGoodreadsCsv(db: Db, userId: string, viewer: Reader): string {
  const visible = visibleBooksWhere(viewer);
  const allowedBook = (bookId: string | null) => {
    if (!bookId) return viewer.role !== "kid";
    return !!db.select({ id: books.id }).from(books).where(and(eq(books.id, bookId), visible)).get();
  };
  const rows = db
    .select()
    .from(readingHistory)
    .where(eq(readingHistory.userId, userId))
    .all()
    .filter((r) => allowedBook(r.bookId));

  // One line per book: prefer the row with the most detail (stars, finish date).
  const byKey = new Map<string, (typeof rows)[number]>();
  const score = (r: (typeof rows)[number]) => (r.stars ? 2 : 0) + (r.finishedAt ? 1 : 0) + (r.status === "read" ? 1 : 0) + (r.source === "goodreads" ? 0.5 : 0);
  for (const r of rows) {
    const key = r.bookId ?? `${r.source}:${r.sourceKey}`;
    const cur = byKey.get(key);
    if (!cur || score(r) > score(cur)) byKey.set(key, r);
  }

  const lines: string[][] = [];
  const goodreadsIdOf = (bookId: string | null) =>
    bookId
      ? (db
          .select({ value: bookIdentifiers.value })
          .from(bookIdentifiers)
          .where(and(eq(bookIdentifiers.bookId, bookId), eq(bookIdentifiers.type, "goodreads")))
          .get()?.value ?? "")
      : "";
  for (const r of byKey.values()) {
    const authors = r.author ? r.author.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const book = r.bookId ? db.select().from(books).where(eq(books.id, r.bookId)).get() : undefined;
    const exclusive = EXCLUSIVE[r.status];
    const shelves = [exclusive, ...(r.shelves ?? [])];
    lines.push(goodreadsLine({
      id: r.source === "goodreads" ? r.sourceKey : goodreadsIdOf(r.bookId),
      title: r.title,
      authors,
      isbn13: r.isbn13 ?? book?.isbn13 ?? null,
      stars: r.stars,
      publisher: book?.publisher ?? null,
      pages: book?.pageCount ?? null,
      year: book?.publishedYear ?? null,
      finishedAt: r.finishedAt,
      addedAt: r.addedAt ?? r.createdAt,
      shelves,
      exclusive,
      review: r.review,
      readCount: r.readCount,
      owned: !!book,
    }));
  }

  // Books finished in Bookbandit with no history row.
  const finished = db
    .select({ bookId: readingProgress.bookId, at: readingProgress.clientUpdatedAt })
    .from(readingProgress)
    .innerJoin(books, eq(books.id, readingProgress.bookId))
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.finished, true), visible))
    .all()
    .filter((p) => !byKey.has(p.bookId));
  if (finished.length) {
    const list = db.select().from(books).where(inArray(books.id, finished.map((f) => f.bookId))).all();
    for (const f of finished) {
      const book = list.find((b) => b.id === f.bookId);
      if (!book) continue;
      lines.push(goodreadsLine({
        id: goodreadsIdOf(book.id),
        title: book.title,
        authors: authorsOf(db, book.id),
        isbn13: book.isbn13,
        stars: null,
        publisher: book.publisher,
        pages: book.pageCount,
        year: book.publishedYear,
        finishedAt: f.at,
        addedAt: f.at,
        shelves: ["read"],
        exclusive: "read",
        review: null,
        readCount: 1,
        owned: true,
      }));
    }
  }
  lines.sort((a, b) => (b[14] ?? "").localeCompare(a[14] ?? "") || (a[1] ?? "").localeCompare(b[1] ?? ""));
  return [GOODREADS_HEADER, ...lines].map((l) => l.map(csvField).join(",")).join("\n") + "\n";
}

function goodreadsLine(r: {
  id: string;
  title: string;
  authors: string[];
  isbn13: string | null;
  stars: number | null;
  publisher: string | null;
  pages: number | null;
  year: number | null;
  finishedAt: number | null;
  addedAt: number | null;
  shelves: string[];
  exclusive: string;
  review: string | null;
  readCount: number;
  owned: boolean;
}): string[] {
  const [first, ...rest] = r.authors;
  return [
    r.id,
    r.title,
    first ?? "",
    first ? lastFirst(first) : "",
    rest.join(", "),
    "",
    r.isbn13 ? `="${r.isbn13}"` : '=""',
    // Goodreads ratings are whole stars.
    r.stars ? String(Math.round(r.stars)) : "0",
    "",
    r.publisher ?? "",
    "",
    r.pages ? String(r.pages) : "",
    r.year ? String(r.year) : "",
    r.year ? String(r.year) : "",
    slashDate(r.finishedAt),
    slashDate(r.addedAt),
    r.shelves.join(", "),
    r.shelves.map((s, i) => `${s} (#${i + 1})`).join(", "),
    r.exclusive,
    r.review ?? "",
    "",
    "",
    String(r.readCount),
    r.owned ? "1" : "0",
  ];
}
