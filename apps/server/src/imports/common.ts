/**
 * Shared pieces for every importer: the dry-run report, the "write or roll back" transaction,
 * matching outside file paths to scanned files, collections, progress and history writes.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ReadingLocator } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookFiles, books, collectionBooks, collections, readingProgress, users } from "../db/schema.js";
import { matchKey } from "../metadata/text.js";
import { bookIdentifiers, importLinks, readingHistory, type ImportSource, type ReadingStatus } from "./schema.js";

/** Anything Drizzle can run queries on: the db itself or a transaction. */
export type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type ItemStatus = "matched" | "new" | "skipped" | "conflict";

export interface ReportItem {
  status: ItemStatus;
  title: string;
  detail?: string;
}

export interface SourcePerson {
  /** The id in the outside app (Calibre-Web user id, Kavita API key index). */
  id: string;
  name: string;
  email?: string | null;
  /** The Bookbandit person this maps to (the admin's choice, or our guess). */
  userId: string | null;
  guessed: boolean;
}

export interface ImportReport {
  source: ImportSource;
  dryRun: boolean;
  counts: Record<ItemStatus, number>;
  /** Extra numbers worth showing ("series linked", "covers", "collections"). */
  stats: Record<string, number>;
  /** The first items of each status, for the report table. */
  items: ReportItem[];
  warnings: string[];
  /** Calibre-Web and Kavita: the outside people and who they map to. */
  people?: SourcePerson[];
}

const MAX_ITEMS_PER_STATUS = 200;

export class Reporter {
  readonly report: ImportReport;
  private perStatus: Record<ItemStatus, number> = { matched: 0, new: 0, skipped: 0, conflict: 0 };

  constructor(source: ImportSource, dryRun: boolean) {
    this.report = { source, dryRun, counts: { matched: 0, new: 0, skipped: 0, conflict: 0 }, stats: {}, items: [], warnings: [] };
  }

  add(status: ItemStatus, title: string, detail?: string): void {
    this.report.counts[status]++;
    if (this.perStatus[status]++ < MAX_ITEMS_PER_STATUS) this.report.items.push({ status, title, ...(detail ? { detail } : {}) });
  }

  stat(name: string, by = 1): void {
    this.report.stats[name] = (this.report.stats[name] ?? 0) + by;
  }

  warn(message: string): void {
    if (this.report.warnings.length < 200 && !this.report.warnings.includes(message)) this.report.warnings.push(message);
  }
}

class DryRunRollback extends Error {}

/**
 * Runs `fn` in one transaction. A dry run rolls it back, so the report counts exactly what a
 * real run would do. Side effects outside the database (copying covers) are returned as
 * callbacks and only run after a real commit.
 */
export async function writeOrRollBack(db: Db, dryRun: boolean, fn: (tx: Tx, after: (task: () => Promise<void>) => void) => void): Promise<void> {
  const tasks: (() => Promise<void>)[] = [];
  try {
    db.transaction((tx) => {
      fn(tx, (t) => tasks.push(t));
      if (dryRun) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
    return;
  }
  for (const t of tasks) await t();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "2023/05/01", "2023-05-01", "2023-05-01 12:34:56.123456" (UTC) → ms, or null. */
export function parseDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h, mi, se, tz] = m;
    if (tz) {
      const t = Date.parse(s.replace(" ", "T").replace(/\//g, "-"));
      return Number.isFinite(t) ? t : null;
    }
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d ?? 1), Number(h ?? 0), Number(mi ?? 0), Number(se ?? 0));
    return Number(y) >= 1000 && Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** ms → "2023/05/01" (Goodreads style). */
export function slashDate(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Matching outside file paths to scanned files
// ---------------------------------------------------------------------------

export interface FileHit {
  bookId: string;
  relPath: string;
  format: string;
}

/**
 * Finds a scanned file by an outside app's path. Calibre and Kavita see the same files under a
 * different mount (`/calibre/Author/Title (42)/Title.epub` vs `Author/Title (42)/Title.epub`),
 * so we match the longest common tail of path segments, needing at least the file name plus its
 * folder unless the file name alone is unique, and the size when both sides know it.
 */
export class FileIndex {
  private byName = new Map<string, { bookId: string; relPath: string; format: string; sizeBytes: number; sha256: string | null }[]>();
  private bySha = new Map<string, FileHit>();

  constructor(tx: Tx) {
    for (const f of tx
      .select({ bookId: bookFiles.bookId, relPath: bookFiles.relPath, format: bookFiles.format, sizeBytes: bookFiles.sizeBytes, sha256: bookFiles.sha256 })
      .from(bookFiles)
      .all()) {
      const name = baseName(f.relPath).toLowerCase();
      const list = this.byName.get(name) ?? [];
      list.push(f);
      this.byName.set(name, list);
      if (f.sha256) this.bySha.set(f.sha256, f);
    }
  }

  get size(): number {
    let n = 0;
    for (const l of this.byName.values()) n += l.length;
    return n;
  }

  byPath(outsidePath: string, sizeBytes?: number): FileHit | undefined {
    const want = segments(outsidePath);
    const name = want.at(-1);
    if (!name) return undefined;
    const candidates = (this.byName.get(name) ?? []).filter((c) => !sizeBytes || !c.sizeBytes || c.sizeBytes === sizeBytes);
    if (!candidates.length) return undefined;
    let best: (typeof candidates)[number] | undefined;
    let bestTail = 0;
    let tie = false;
    for (const c of candidates) {
      const have = segments(c.relPath);
      let tail = 0;
      while (tail < have.length && tail < want.length && have[have.length - 1 - tail] === want[want.length - 1 - tail]) tail++;
      if (tail > bestTail) {
        best = c;
        bestTail = tail;
        tie = false;
      } else if (tail === bestTail) tie = true;
    }
    if (!best || tie) return undefined;
    // A bare file name is only trusted when it is the only file with that name (and size).
    if (bestTail < 2 && candidates.length > 1) return undefined;
    return { bookId: best.bookId, relPath: best.relPath, format: best.format };
  }

  bySha256(sha: string): FileHit | undefined {
    return this.bySha.get(sha);
  }
}

function segments(p: string): string[] {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".")
    .map((s) => s.toLowerCase());
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

// ---------------------------------------------------------------------------
// Links and identifiers
// ---------------------------------------------------------------------------

export function linkedBook(tx: Tx, source: ImportSource, sourceId: string): string | undefined {
  const row = tx
    .select({ bookId: importLinks.bookId })
    .from(importLinks)
    .where(and(eq(importLinks.source, source), eq(importLinks.sourceId, sourceId)))
    .get();
  return row?.bookId;
}

export function saveLink(tx: Tx, source: ImportSource, sourceId: string, bookId: string): void {
  const now = Date.now();
  tx.insert(importLinks)
    .values({ source, sourceId, bookId, updatedAt: now })
    .onConflictDoUpdate({ target: [importLinks.source, importLinks.sourceId], set: { bookId, updatedAt: now } })
    .run();
}

export function setIdentifier(tx: Tx, bookId: string, type: string, value: string): void {
  const t = type.trim().toLowerCase().slice(0, 40);
  const v = value.trim().slice(0, 200);
  if (!t || !v) return;
  tx.insert(bookIdentifiers)
    .values({ bookId, type: t, value: v })
    .onConflictDoUpdate({ target: [bookIdentifiers.bookId, bookIdentifiers.type], set: { value: v } })
    .run();
}

export function bookByIdentifier(tx: Tx, type: string, value: string): string | undefined {
  return tx
    .select({ bookId: bookIdentifiers.bookId })
    .from(bookIdentifiers)
    .where(and(eq(bookIdentifiers.type, type), eq(bookIdentifiers.value, value)))
    .get()?.bookId;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface Person {
  id: string;
  householdId: string;
  displayName: string;
  role: string;
}

export function person(tx: Tx, userId: string): Person | undefined {
  return tx
    .select({ id: users.id, householdId: users.householdId, displayName: users.displayName, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
}

/** Our best guess at who an outside account is: same email, then same name. */
export function guessPerson(
  people: { id: string; displayName: string; emails: string[] }[],
  outside: { name: string; email?: string | null },
): string | null {
  const email = outside.email?.trim().toLowerCase();
  if (email) {
    const byEmail = people.find((p) => p.emails.includes(email));
    if (byEmail) return byEmail.id;
  }
  const key = matchKey(outside.name);
  if (!key) return null;
  const byName = people.filter((p) => matchKey(p.displayName) === key);
  return byName.length === 1 ? byName[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** A collection by name for this owner (null = shared with the household), created if needed. */
export function ensureCollection(tx: Tx, householdId: string, ownerId: string | null, name: string, report?: Reporter): string {
  const clean = name.trim().slice(0, 120) || "Imported";
  const existing = tx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.householdId, householdId),
        ownerId ? eq(collections.ownerId, ownerId) : isNull(collections.ownerId),
        sql`lower(${collections.name}) = ${clean.toLowerCase()}`,
      ),
    )
    .get();
  if (existing) return existing.id;
  report?.stat("collections created");
  return tx.insert(collections).values({ householdId, ownerId, name: clean }).returning({ id: collections.id }).get().id;
}

/** Adds a book at the end of a collection. Returns false when it was already there. */
export function addToCollection(tx: Tx, collectionId: string, bookId: string): boolean {
  const there = tx
    .select({ b: collectionBooks.bookId })
    .from(collectionBooks)
    .where(and(eq(collectionBooks.collectionId, collectionId), eq(collectionBooks.bookId, bookId)))
    .get();
  if (there) return false;
  const max = tx
    .select({ n: sql<number>`coalesce(max(${collectionBooks.position}), -1)` })
    .from(collectionBooks)
    .where(eq(collectionBooks.collectionId, collectionId))
    .get()?.n;
  tx.insert(collectionBooks).values({ collectionId, bookId, position: (max ?? -1) + 1 }).run();
  return true;
}

// ---------------------------------------------------------------------------
// Progress and history
// ---------------------------------------------------------------------------

/** A locator that opens the book at the start, in the shape the reader wants for its format. */
export function startLocator(tx: Tx, bookId: string, percent: number): ReadingLocator {
  const file = tx.select({ format: bookFiles.format }).from(bookFiles).where(eq(bookFiles.bookId, bookId)).all();
  const pageBased = file.length > 0 && file.every((f) => f.format === "pdf" || f.format === "cbz" || f.format === "cbr");
  if (pageBased) {
    const total = tx.select({ n: books.pageCount }).from(books).where(eq(books.id, bookId)).get()?.n ?? 0;
    const totalPages = Math.max(1, total);
    return { kind: "page", page: Math.min(totalPages - 1, Math.max(0, Math.round(percent * totalPages) - 1)), totalPages };
  }
  // Same fallback the Kobo sync uses when only a percentage is known.
  return { kind: "epub", cfi: "epubcfi(/6/2!/4)", percent };
}

export type ProgressOutcome = "written" | "kept-newer" | "unchanged";

/**
 * Saves an imported position, newest wins like every other sync source. `at` is when the
 * outside app recorded it. A finished book is never turned back into an unfinished one by an
 * older import.
 */
export function importProgress(
  tx: Tx,
  userId: string,
  bookId: string,
  p: { percent: number; finished: boolean; at: number; locator?: ReadingLocator; deviceName: string },
): ProgressOutcome {
  const current = tx
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, bookId)))
    .get();
  const percent = Math.min(1, Math.max(0, Number.isFinite(p.percent) ? p.percent : 0));
  if (current) {
    if (current.finished === p.finished && Math.abs(current.percent - percent) < 0.005) return "unchanged";
    if (current.clientUpdatedAt >= p.at) return "kept-newer";
  }
  const now = Date.now();
  const values = {
    locator: p.locator ?? startLocator(tx, bookId, percent),
    percent,
    finished: p.finished,
    deviceName: p.deviceName.slice(0, 80),
    clientUpdatedAt: Math.min(p.at, now),
    serverUpdatedAt: now,
  };
  tx.insert(readingProgress)
    .values({ userId, bookId, ...values })
    .onConflictDoUpdate({ target: [readingProgress.userId, readingProgress.bookId], set: values })
    .run();
  return "written";
}

export interface HistoryInput {
  userId: string;
  bookId: string | null;
  title: string;
  author?: string | null;
  isbn13?: string | null;
  status: ReadingStatus;
  stars?: number | null;
  review?: string | null;
  shelves?: string[];
  readCount?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  addedAt?: number | null;
  source: ImportSource;
  sourceKey: string;
}

type HistoryRow = typeof readingHistory.$inferSelect;

const HISTORY_FIELDS = ["bookId", "title", "author", "isbn13", "status", "stars", "review", "shelves", "readCount", "startedAt", "finishedAt", "addedAt"] as const;

/** Inserts or updates one history row (keyed by person, source and source key). */
export function upsertHistory(tx: Tx, h: HistoryInput): "new" | "updated" | "unchanged" {
  const current = tx
    .select()
    .from(readingHistory)
    .where(and(eq(readingHistory.userId, h.userId), eq(readingHistory.source, h.source), eq(readingHistory.sourceKey, h.sourceKey)))
    .get();
  const values = {
    bookId: h.bookId,
    title: h.title.slice(0, 500),
    author: h.author?.slice(0, 300) || null,
    isbn13: h.isbn13 ?? null,
    status: h.status,
    stars: h.stars ?? null,
    review: h.review?.slice(0, 20_000) || null,
    shelves: h.shelves?.length ? h.shelves.slice(0, 50) : null,
    readCount: h.readCount ?? (h.status === "read" ? 1 : 0),
    startedAt: h.startedAt ?? null,
    finishedAt: h.finishedAt ?? null,
    addedAt: h.addedAt ?? null,
  };
  if (current) {
    const same = HISTORY_FIELDS.every((k) => JSON.stringify((current as HistoryRow)[k] ?? null) === JSON.stringify(values[k] ?? null));
    if (same) return "unchanged";
    tx.update(readingHistory)
      .set({ ...values, updatedAt: Date.now() })
      .where(eq(readingHistory.id, current.id))
      .run();
    return "updated";
  }
  tx.insert(readingHistory)
    .values({ userId: h.userId, source: h.source, sourceKey: h.sourceKey.slice(0, 300), ...values, updatedAt: Date.now() })
    .run();
  return "new";
}

/** Book ids that exist (guards links that point at deleted books). */
export function existingBookIds(tx: Tx, ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of tx.select({ id: books.id }).from(books).where(inArray(books.id, ids.slice(i, i + 500))).all()) out.add(r.id);
  }
  return out;
}

/** Author names of a book, in order. */
export function authorsOf(tx: Tx, bookId: string): string[] {
  return tx
    .select({ name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(and(eq(bookAuthors.bookId, bookId), eq(bookAuthors.role, "author")))
    .orderBy(bookAuthors.position)
    .all()
    .map((r) => r.name);
}
