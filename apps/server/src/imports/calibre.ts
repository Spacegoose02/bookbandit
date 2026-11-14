/**
 * Calibre `metadata.db` import. Reads the library database read-only and copies the owner's
 * curated metadata (titles, authors, series and index, tags, identifiers, publisher, language,
 * description, cover) onto the books Bookbandit already scanned from the same files.
 *
 * Files stay where they are: matching is by path (Calibre's `Author/Title (id)/name.ext` tail),
 * then by file hash when the Calibre folder is readable, then by ISBN or title and author.
 * Calibre books with no file in Bookbandit are skipped and listed, so the admin can scan first.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books, bookSeries, bookTags, series, tags } from "../db/schema.js";
import { saveCover } from "../library/covers.js";
import { sha256File } from "../library/hash.js";
import { findSameWork, setBookAuthors, setBookSeries } from "../library/store.js";
import { toIsbn13 } from "../metadata/isbn.js";
import { collapse, sortTitle, stripHtml } from "../metadata/text.js";
import { authorsOf, FileIndex, linkedBook, saveLink, setIdentifier, writeOrRollBack, type Reporter, type Tx } from "./common.js";

export interface CalibreFile {
  dataId: number;
  format: string;
  /** Path inside the Calibre library folder. */
  relPath: string;
  size: number | null;
}

export interface CalibreBook {
  id: number;
  uuid: string | null;
  title: string;
  sort: string | null;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  tags: string[];
  identifiers: Record<string, string>;
  publisher: string | null;
  languages: string[];
  description: string | null;
  pubYear: number | null;
  path: string;
  hasCover: boolean;
  files: CalibreFile[];
}

export interface CalibreLibrary {
  uuid: string;
  books: CalibreBook[];
}

/** Opens a SQLite file read-only and checks it has the tables we need. */
export function openForeignDb(path: string, needTables: string[], what: string): Database.Database {
  if (!existsSync(path)) throw new Error(`${what}: file not found`);
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw new Error(`${what}: can't open it (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    const have = new Set(
      (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    const missing = needTables.filter((t) => !have.has(t));
    if (missing.length) throw new Error(`${what}: this doesn't look like the right file (no ${missing.join(", ")} table)`);
  } catch (e) {
    db.close();
    throw e instanceof Error && e.message.startsWith(what) ? e : new Error(`${what}: not a SQLite database`);
  }
  return db;
}

const tableExists = (db: Database.Database, name: string) =>
  !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);

export function readCalibreLibrary(path: string): CalibreLibrary {
  const db = openForeignDb(path, ["books", "authors", "books_authors_link", "data"], "Calibre library");
  try {
    const uuid = tableExists(db, "library_id")
      ? ((db.prepare("select uuid from library_id limit 1").get() as { uuid?: string } | undefined)?.uuid ?? "calibre")
      : "calibre";
    const group = <T extends { book: number }>(rows: T[]) => {
      const m = new Map<number, T[]>();
      for (const r of rows) {
        const l = m.get(r.book) ?? [];
        l.push(r);
        m.set(r.book, l);
      }
      return m;
    };
    const all = <T>(q: string, table: string): T[] => (tableExists(db, table) ? (db.prepare(q).all() as T[]) : []);

    const authors = group(
      db
        .prepare("select l.book as book, a.name as name from books_authors_link l join authors a on a.id = l.author order by l.id")
        .all() as { book: number; name: string }[],
    );
    const seriesRows = group(
      all<{ book: number; name: string }>("select l.book as book, s.name as name from books_series_link l join series s on s.id = l.series", "books_series_link"),
    );
    const tagRows = group(
      all<{ book: number; name: string }>("select l.book as book, t.name as name from books_tags_link l join tags t on t.id = l.tag order by t.name", "books_tags_link"),
    );
    const idRows = group(all<{ book: number; type: string; val: string }>("select book, type, val from identifiers", "identifiers"));
    const pubRows = group(
      all<{ book: number; name: string }>(
        "select l.book as book, p.name as name from books_publishers_link l join publishers p on p.id = l.publisher",
        "books_publishers_link",
      ),
    );
    const langRows = group(
      all<{ book: number; code: string }>(
        "select l.book as book, g.lang_code as code from books_languages_link l join languages g on g.id = l.lang_code order by l.item_order",
        "books_languages_link",
      ),
    );
    const comments = group(all<{ book: number; text: string }>("select book, text from comments", "comments"));
    const data = group(
      db.prepare("select id, book, format, name, uncompressed_size as size from data").all() as {
        id: number;
        book: number;
        format: string;
        name: string;
        size: number | null;
      }[],
    );

    const rows = db
      .prepare("select id, uuid, title, sort, path, has_cover as hasCover, series_index as seriesIndex, pubdate from books order by id")
      .all() as {
      id: number;
      uuid: string | null;
      title: string;
      sort: string | null;
      path: string;
      hasCover: number;
      seriesIndex: number | null;
      pubdate: string | null;
    }[];

    return {
      uuid,
      books: rows.map((b) => {
        const s = seriesRows.get(b.id)?.[0]?.name ?? null;
        const year = b.pubdate ? Number(b.pubdate.slice(0, 4)) : NaN;
        return {
          id: b.id,
          uuid: b.uuid,
          title: collapse(b.title ?? "") || "Untitled",
          sort: b.sort,
          authors: (authors.get(b.id) ?? []).map((a) => collapse(a.name.replace(/\|/g, ","))).filter((a) => a && a !== "Unknown"),
          series: s,
          seriesIndex: s ? (b.seriesIndex ?? null) : null,
          tags: (tagRows.get(b.id) ?? []).map((t) => t.name),
          identifiers: Object.fromEntries((idRows.get(b.id) ?? []).map((i) => [i.type.toLowerCase(), i.val])),
          publisher: pubRows.get(b.id)?.[0]?.name ?? null,
          languages: (langRows.get(b.id) ?? []).map((l) => l.code),
          description: comments.get(b.id)?.[0]?.text ?? null,
          // Calibre stores "0101-01-01" for an unknown date.
          pubYear: Number.isFinite(year) && year >= 1000 && year <= 2200 ? year : null,
          path: b.path,
          hasCover: !!b.hasCover,
          files: (data.get(b.id) ?? []).map((d) => ({
            dataId: d.id,
            format: d.format.toLowerCase(),
            relPath: `${b.path}/${d.name}.${d.format.toLowerCase()}`,
            size: d.size ?? null,
          })),
        };
      }),
    };
  } finally {
    db.close();
  }
}

const LANG3: Record<string, string> = {
  eng: "en", fra: "fr", fre: "fr", deu: "de", ger: "de", spa: "es", ita: "it", nld: "nl", dut: "nl", por: "pt",
  swe: "sv", nor: "no", nob: "nb", dan: "da", fin: "fi", pol: "pl", rus: "ru", jpn: "ja", zho: "zh", chi: "zh",
  kor: "ko", ara: "ar", heb: "he", tur: "tr", ces: "cs", cze: "cs", hun: "hu", ell: "el", gre: "el", ukr: "uk",
};

export function languageCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.trim().toLowerCase();
  return LANG3[c] ?? c.slice(0, 16);
}

export interface CalibreOptions {
  /** "calibre": Calibre's values replace ours (default). "fill-gaps": only fill empty fields. */
  overwrite: "calibre" | "fill-gaps";
  covers: boolean;
  /** Approve matched books that are still waiting in the inbox. Their age group is kept. */
  approve: boolean;
}

export interface CalibreMatch {
  bookId: string;
  how: "link" | "path" | "hash" | "isbn-or-title";
}

/**
 * Where each Calibre book is in Bookbandit. Async because the hash fallback reads files.
 * `libraryDir` is the Calibre folder on this server (unknown for an uploaded metadata.db).
 */
export async function matchCalibreBooks(db: Db, lib: CalibreLibrary, libraryDir: string | null): Promise<Map<number, CalibreMatch>> {
  const index = new FileIndex(db);
  const out = new Map<number, CalibreMatch>();
  for (const b of lib.books) {
    const linked = linkedBook(db, "calibre", `${lib.uuid}:${b.id}`);
    if (linked && db.select({ id: books.id }).from(books).where(eq(books.id, linked)).get()) {
      out.set(b.id, { bookId: linked, how: "link" });
      continue;
    }
    const byPath = b.files.map((f) => index.byPath(f.relPath, f.size ?? undefined)).find(Boolean);
    if (byPath) {
      out.set(b.id, { bookId: byPath.bookId, how: "path" });
      continue;
    }
    if (libraryDir) {
      let hit: string | undefined;
      for (const f of b.files) {
        const abs = join(libraryDir, f.relPath);
        if (!existsSync(abs)) continue;
        const sha = await sha256File(abs).catch(() => null);
        const found = sha ? index.bySha256(sha) : undefined;
        if (found) {
          hit = found.bookId;
          break;
        }
      }
      if (hit) {
        out.set(b.id, { bookId: hit, how: "hash" });
        continue;
      }
    }
    // Only books that have a file here: a metadata match alone could be a Kindle entry.
    const same = findSameWork(db, { title: b.title, authors: b.authors, isbn13: toIsbn13(b.identifiers.isbn) });
    if (same && !same.kindleOnly) out.set(b.id, { bookId: same.id, how: "isbn-or-title" });
  }
  return out;
}

const differs = (a: unknown, b: unknown) =>
  a != null && a !== "" && b != null && b !== "" && String(a).trim().toLowerCase() !== String(b).trim().toLowerCase();

export async function importCalibre(
  db: Db,
  lib: CalibreLibrary,
  matches: Map<number, CalibreMatch>,
  opts: CalibreOptions & { dryRun: boolean; libraryDir: string | null; configDir: string },
  report: Reporter,
  progress: (f: number) => void = () => {},
): Promise<void> {
  if (opts.covers && !opts.libraryDir) report.warn("Covers weren't copied: point the import at the Calibre folder on the server instead of uploading metadata.db to bring covers too.");
  const seen = new Set<string>();
  await writeOrRollBack(db, opts.dryRun, (tx, after) => {
    lib.books.forEach((b, i) => {
      if (i % 200 === 0) progress(i / Math.max(1, lib.books.length));
      const label = b.authors.length ? `${b.title} — ${b.authors.join(", ")}` : b.title;
      const m = matches.get(b.id);
      if (!m) {
        report.add(
          "skipped",
          label,
          b.files.length
            ? `No file for it in Bookbandit yet (${b.files.map((f) => f.format.toUpperCase()).join(", ")}). Scan the library, or check the Calibre folder is inside /books.`
            : "Calibre has no file for this book.",
        );
        return;
      }
      if (seen.has(m.bookId)) {
        report.add("skipped", label, "Another Calibre book already matched the same Bookbandit book (a duplicate in Calibre?).");
        return;
      }
      seen.add(m.bookId);
      const current = tx.select().from(books).where(eq(books.id, m.bookId)).get();
      if (!current) return;
      const conflicts = applyOne(db, tx, b, current, opts, report, after);
      saveLink(tx, "calibre", `${lib.uuid}:${b.id}`, m.bookId);
      const how = { link: "", path: "", hash: " (matched by file hash)", "isbn-or-title": " (matched by ISBN or title and author)" }[m.how];
      if (conflicts.length)
        report.add(
          "conflict",
          label,
          `${opts.overwrite === "calibre" ? "Calibre's value wins" : "Bookbandit's value kept"} for ${conflicts.join(", ")}${how}`,
        );
      else report.add("matched", label, how.trim() ? how.trim().replace(/^\(|\)$/g, "") : undefined);
    });
  });
  progress(1);
}

function applyOne(
  db: Db,
  tx: Tx,
  b: CalibreBook,
  current: typeof books.$inferSelect,
  opts: CalibreOptions & { configDir: string; libraryDir: string | null },
  report: Reporter,
  after: (task: () => Promise<void>) => void,
): string[] {
  const conflicts: string[] = [];
  const replace = opts.overwrite === "calibre";
  const set: Partial<typeof books.$inferInsert> = {};
  const field = <K extends keyof typeof books.$inferInsert>(key: K, label: string, value: (typeof books.$inferInsert)[K] | null | undefined) => {
    if (value == null || value === "") return;
    const cur = current[key as keyof typeof current];
    if (cur == null || cur === "") set[key] = value;
    else if (differs(cur, value)) {
      conflicts.push(label);
      if (replace) set[key] = value;
    }
  };

  field("title", "title", b.title);
  if (set.title) set.sortTitle = sortTitle(set.title);
  field("description", "description", b.description ? stripHtml(b.description) : null);
  field("publisher", "publisher", b.publisher);
  field("language", "language", languageCode(b.languages[0]));
  field("publishedYear", "year", b.pubYear);
  field("isbn13", "ISBN", toIsbn13(b.identifiers.isbn));
  if (b.identifiers.google) field("googleBooksId", "Google Books id", b.identifiers.google);
  if (opts.approve && !current.approved) {
    set.approved = true;
    report.stat("approved from the inbox");
  }
  if (Object.keys(set).length) {
    tx.update(books)
      .set({ ...set, updatedAt: Date.now() })
      .where(eq(books.id, current.id))
      .run();
  }

  // Authors
  if (b.authors.length) {
    const have = authorsOf(tx, current.id);
    if (!have.length) setBookAuthors(tx, current.id, b.authors);
    else if (have.join("|").toLowerCase() !== b.authors.join("|").toLowerCase()) {
      conflicts.push("authors");
      if (replace) setBookAuthors(tx, current.id, b.authors);
    }
  }

  // Series: Calibre's is the family's curated one; admin-managed series in Bookbandit are kept.
  if (b.series) {
    const links = tx
      .select({ seriesId: bookSeries.seriesId, name: series.name, position: bookSeries.position, adminManaged: series.adminManaged })
      .from(bookSeries)
      .innerJoin(series, eq(series.id, bookSeries.seriesId))
      .where(eq(bookSeries.bookId, current.id))
      .all();
    const same = links.find((l) => l.name.toLowerCase() === b.series!.toLowerCase());
    if (same) {
      if (same.position !== b.seriesIndex && b.seriesIndex != null) {
        if (same.position == null || replace) {
          tx.update(bookSeries)
            .set({ position: b.seriesIndex })
            .where(and(eq(bookSeries.bookId, current.id), eq(bookSeries.seriesId, same.seriesId)))
            .run();
        }
        if (same.position != null) conflicts.push("series number");
      }
    } else if (!links.length) {
      setBookSeries(tx, current.id, b.series, b.seriesIndex ?? undefined);
      report.stat("series linked");
    } else {
      conflicts.push("series");
      if (replace && !links.some((l) => l.adminManaged)) {
        tx.delete(bookSeries).where(eq(bookSeries.bookId, current.id)).run();
        setBookSeries(tx, current.id, b.series, b.seriesIndex ?? undefined);
        report.stat("series linked");
      }
    }
  }

  // Tags are added, never removed.
  for (const name of b.tags.map(collapse).filter((t) => t && t.length <= 60)) {
    tx.insert(tags).values({ name, kind: "genre" }).onConflictDoNothing().run();
    const tag = tx.select({ id: tags.id }).from(tags).where(and(eq(tags.name, name), eq(tags.kind, "genre"))).get();
    if (tag) {
      const added = tx.insert(bookTags).values({ bookId: current.id, tagId: tag.id }).onConflictDoNothing().run().changes;
      if (added) report.stat("tags added");
    }
  }

  for (const [type, value] of Object.entries(b.identifiers)) setIdentifier(tx, current.id, type, value);
  if (b.uuid) setIdentifier(tx, current.id, "calibre", b.uuid);

  // Cover: Calibre keeps cover.jpg next to the book files.
  if (opts.covers && b.hasCover && opts.libraryDir && (!current.coverPath || replace)) {
    const abs = join(opts.libraryDir, b.path, "cover.jpg");
    report.stat("covers");
    const bookId = current.id;
    const configDir = opts.configDir;
    after(async () => {
      const data = await readFile(abs).catch(() => null);
      if (!data) return;
      const rel = await saveCover(configDir, bookId, { data, mime: "image/jpeg" });
      // after() runs once the transaction committed, so this writes through the plain db.
      if (rel) db.update(books).set({ coverPath: rel, updatedAt: Date.now() }).where(eq(books.id, bookId)).run();
    });
  }
  return conflicts;
}

/** Calibre book id → Bookbandit book id, for Calibre-Web (which only knows Calibre's ids). */
export function calibreIdMap(db: Db, lib: CalibreLibrary | null, matches: Map<number, CalibreMatch> | null): Map<number, string> {
  const out = new Map<number, string>();
  if (lib && matches) {
    for (const [id, m] of matches) out.set(id, m.bookId);
    return out;
  }
  // No metadata.db given: use links from an earlier Calibre import, if they're from one library.
  const rows = db.all<{ sourceId: string; bookId: string }>(
    sql`select source_id as sourceId, book_id as bookId from import_links where source = 'calibre'`,
  );
  const libraries = new Set(rows.map((r) => r.sourceId.split(":")[0]));
  if (libraries.size > 1) throw new Error("Bookbandit has imported more than one Calibre library; choose the metadata.db that goes with this Calibre-Web.");
  for (const r of rows) out.set(Number(r.sourceId.split(":").pop()), r.bookId);
  return out;
}
