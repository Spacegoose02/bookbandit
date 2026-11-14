/**
 * Library-wide duplicates. Two kinds:
 *
 * - "copies": the same bytes at more than one path (the scanner attaches them to one book).
 *   Fix: keep one path and set the other copies aside.
 * - "same work": separate book records that look like one work (same ISBN, or the same title and
 *   an overlapping author, or the same title with no authors to compare). Fix: merge their formats
 *   into one book, keep one and set the others' files aside, or mark them "not duplicates".
 *
 * Nothing is deleted: set-aside files move to BOOKS_DIR/.duplicates, which scans skip.
 */
import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookFiles, books } from "../db/schema.js";
import { matchKey } from "../metadata/text.js";
import { describeBooks, loadBooks, readerCounts, type LibrarianBook } from "./books.js";
import { duplicateIgnores } from "./schema.js";

export const SET_ASIDE_DIR = ".duplicates";

export type DuplicateReason = "isbn" | "title_author" | "title";

export interface WorkGroup {
  key: string;
  reason: DuplicateReason;
  books: (LibrarianBook & { readers: number; bookmarks: number })[];
}

export interface CopyGroup {
  sha256: string;
  sizeBytes: number;
  files: { id: string; relPath: string; format: string; bookId: string; bookTitle: string }[];
}

export const groupKey = (ids: string[]) => [...ids].sort().join(",");

/** Groups of book ids that look like the same work. Pure function of the rows, for tests. */
export function findWorkGroups(
  rows: { id: string; title: string; isbn13: string | null }[],
  authorsBy: Map<string, string[]>,
): { reason: DuplicateReason; ids: string[] }[] {
  // Union-find, so A~B by ISBN and B~C by title end up as one group.
  const parent = new Map<string, string>();
  const reasonOf = new Map<string, DuplicateReason>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(x, p);
    return p;
  };
  const rank: Record<DuplicateReason, number> = { isbn: 0, title_author: 1, title: 2 };
  const union = (a: string, b: string, why: DuplicateReason) => {
    const ra = find(a);
    const rb = find(b);
    const best = [reasonOf.get(ra), reasonOf.get(rb), why].filter(Boolean).sort((x, y) => rank[x!] - rank[y!])[0]!;
    if (ra !== rb) parent.set(rb, ra);
    reasonOf.set(ra, best);
  };

  const byIsbn = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  for (const r of rows) {
    if (r.isbn13) byIsbn.set(r.isbn13, [...(byIsbn.get(r.isbn13) ?? []), r.id]);
    const t = matchKey(r.title);
    if (t.length >= 2) byTitle.set(t, [...(byTitle.get(t) ?? []), r.id]);
  }
  for (const ids of byIsbn.values()) for (const id of ids.slice(1)) union(ids[0]!, id, "isbn");
  for (const ids of byTitle.values()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = new Set((authorsBy.get(ids[i]!) ?? []).map(matchKey));
        const b = (authorsBy.get(ids[j]!) ?? []).map(matchKey);
        if (b.some((x) => a.has(x))) union(ids[i]!, ids[j]!, "title_author");
        // Same title and one side has no author at all: likely a badly named file of the same book.
        else if (!a.size || !b.length) union(ids[i]!, ids[j]!, "title");
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    if (!parent.has(r.id) && !reasonOf.has(r.id)) continue;
    const root = find(r.id);
    groups.set(root, [...(groups.get(root) ?? []), r.id]);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([root, ids]) => ({ reason: reasonOf.get(root) ?? "title", ids }));
}

export function listDuplicates(db: Db): { sameWork: WorkGroup[]; copies: CopyGroup[]; ignored: number } {
  const rows = db.select({ id: books.id, title: books.title, isbn13: books.isbn13 }).from(books).all();
  const authorsBy = new Map<string, string[]>();
  for (const r of db
    .select({ bookId: bookAuthors.bookId, name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .all())
    authorsBy.set(r.bookId, [...(authorsBy.get(r.bookId) ?? []), r.name]);

  const ignoredKeys = new Set(db.select({ k: duplicateIgnores.groupKey }).from(duplicateIgnores).all().map((r) => r.k));
  const groups = findWorkGroups(rows, authorsBy).filter((g) => !ignoredKeys.has(groupKey(g.ids)));
  const allIds = groups.flatMap((g) => g.ids);
  const described = new Map(describeBooks(db, loadBooks(db, allIds)).map((b) => [b.id, b]));
  const counts = readerCounts(db, allIds);
  const sameWork = groups
    .map((g) => ({
      key: groupKey(g.ids),
      reason: g.reason,
      books: g.ids
        .map((id) => described.get(id))
        .filter((b): b is LibrarianBook => !!b)
        .map((b) => ({ ...b, ...(counts.get(b.id) ?? { readers: 0, bookmarks: 0 }) }))
        // Approved, most-read, most formats first: the usual "keep" choice on the left.
        .sort((a, b) => Number(b.approved) - Number(a.approved) || b.readers - a.readers || b.files.length - a.files.length || a.addedAt - b.addedAt),
    }))
    .sort((a, b) => a.books[0]!.title.localeCompare(b.books[0]!.title));

  const hashes = db
    .select({ sha256: bookFiles.sha256 })
    .from(bookFiles)
    .where(isNotNull(bookFiles.sha256))
    .groupBy(bookFiles.sha256)
    .having(sql`count(*) > 1`)
    .all()
    .map((r) => r.sha256!);
  const copyRows = hashes.length
    ? db
        .select({ id: bookFiles.id, relPath: bookFiles.relPath, format: bookFiles.format, sizeBytes: bookFiles.sizeBytes, sha256: bookFiles.sha256, bookId: bookFiles.bookId, bookTitle: books.title })
        .from(bookFiles)
        .innerJoin(books, eq(books.id, bookFiles.bookId))
        .where(inArray(bookFiles.sha256, hashes))
        .all()
    : [];
  const copies = new Map<string, CopyGroup>();
  for (const { sha256, sizeBytes, ...f } of copyRows) {
    const g = copies.get(sha256!) ?? { sha256: sha256!, sizeBytes, files: [] };
    g.files.push(f);
    copies.set(sha256!, g);
  }
  for (const g of copies.values()) g.files.sort((a, b) => a.relPath.length - b.relPath.length || a.relPath.localeCompare(b.relPath));

  return { sameWork, copies: [...copies.values()].sort((a, b) => a.files[0]!.relPath.localeCompare(b.files[0]!.relPath)), ignored: ignoredKeys.size };
}
