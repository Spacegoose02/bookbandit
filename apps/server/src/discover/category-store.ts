/**
 * Writes for categories: linking a book's subjects and curated categories, admin merge / rename /
 * hide, and the one-time clean-up of libraries scanned before categories were curated.
 *
 * Nothing here removes a book from a category it was in, except the "Fiction" / "Nonfiction"
 * fallback once a real category is found. Merging moves every book link before the old tag goes.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookTags, settings, tags } from "../db/schema.js";
import { categoryAliases, categoryPrefs } from "./schema.js";
import { classifySubjects, cleanSubjects, FALLBACK_NAMES, subjectKey } from "./taxonomy.js";

type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;
type Kind = (typeof tags.$inferSelect)["kind"];

export const TAXONOMY_VERSION = 1;
const VERSION_KEY = "categories.taxonomy";
const MIN_BOOKS_KEY = "categories.minBooks";
export const DEFAULT_MIN_BOOKS = 3;

/** The first letter or digit of a name, for narrowing a lookup before comparing keys. */
function firstChar(name: string): string {
  return subjectKey(name).charAt(0);
}

/** A tag of one of `kinds` whose name means the same as `name` (case, "&", plurals, punctuation). */
export function findTagByKey(tx: Tx, name: string, kinds: Kind[]): { id: string; name: string; kind: Kind } | undefined {
  const key = subjectKey(name);
  if (!key) return undefined;
  const rows = tx
    .select({ id: tags.id, name: tags.name, kind: tags.kind })
    .from(tags)
    .where(and(inArray(tags.kind, kinds), like(tags.name, `${firstChar(name)}%`)))
    .all();
  const same = rows.filter((r) => subjectKey(r.name) === key);
  // An exact spelling first, then the order of `kinds`.
  return same.find((r) => r.name === name) ?? same.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind))[0];
}

function aliasFor(tx: Tx, name: string): string | undefined {
  const key = subjectKey(name);
  if (!key) return undefined;
  return tx.select({ tagId: categoryAliases.tagId }).from(categoryAliases).where(eq(categoryAliases.key, key)).get()?.tagId;
}

/** The tag a subject or category name lands on: an admin alias, an existing near-duplicate, or a new tag. */
export function ensureTag(tx: Tx, name: string, kind: "genre" | "subject"): string {
  const aliased = aliasFor(tx, name);
  if (aliased) return aliased;
  const found = findTagByKey(tx, name, [kind]);
  if (found) return found.id;
  tx.insert(tags).values({ name, kind }).onConflictDoNothing().run();
  return tx.select({ id: tags.id }).from(tags).where(and(eq(tags.name, name), eq(tags.kind, kind))).get()!.id;
}

function link(tx: Tx, bookId: string, tagId: string): boolean {
  return tx.insert(bookTags).values({ bookId, tagId }).onConflictDoNothing().run().changes > 0;
}

/** Ids of the "Fiction" / "Nonfiction" fallback categories. */
function fallbackIds(tx: Tx): string[] {
  return tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.kind, "genre"), inArray(tags.name, FALLBACK_NAMES)))
    .all()
    .map((r) => r.id);
}

/**
 * Files a book under the curated categories its subjects point to. A fallback ("Fiction") is only
 * added to a book with no category yet, and is taken off once a real one is found.
 * Returns how many new links were made.
 */
export function linkCategories(tx: Tx, bookId: string, subjects: readonly string[]): number {
  const names = classifySubjects(subjects);
  if (!names.length) return 0;
  const real = names.filter((n) => !FALLBACK_NAMES.includes(n));
  const fallbacks = fallbackIds(tx);
  let added = 0;
  if (!real.length) {
    const hasCategory = tx
      .select({ id: tags.id })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(and(eq(bookTags.bookId, bookId), eq(tags.kind, "genre")))
      .get();
    if (hasCategory) return 0;
  }
  for (const name of names) if (link(tx, bookId, ensureTag(tx, name, "genre"))) added++;
  if (real.length && fallbacks.length)
    tx.delete(bookTags).where(and(eq(bookTags.bookId, bookId), inArray(bookTags.tagId, fallbacks))).run();
  return added;
}

/**
 * What the scanner, enrichment and imports call with a book's raw subjects: keeps the useful ones
 * as `subject` tags and files the book under curated categories. Returns new subject links.
 */
export function applySubjects(tx: Tx, bookId: string, subjects: readonly string[] | undefined): number {
  if (!subjects?.length) return 0;
  let added = 0;
  for (const name of cleanSubjects(subjects)) if (link(tx, bookId, ensureTag(tx, name, "subject"))) added++;
  linkCategories(tx, bookId, subjects);
  return added;
}

function moveLinks(tx: Tx, fromId: string, intoId: string): void {
  const ids = tx.select({ bookId: bookTags.bookId }).from(bookTags).where(eq(bookTags.tagId, fromId)).all();
  for (const { bookId } of ids) link(tx, bookId, intoId);
}

/** Moves every book from one tag to another, remembers the old name, and deletes the old tag. */
export function mergeTag(tx: Tx, fromId: string, intoId: string): void {
  if (fromId === intoId) return;
  const from = tx.select().from(tags).where(eq(tags.id, fromId)).get();
  if (!from) return;
  moveLinks(tx, fromId, intoId);
  tx.update(categoryAliases).set({ tagId: intoId }).where(eq(categoryAliases.tagId, fromId)).run();
  tx.delete(tags).where(eq(tags.id, fromId)).run();
  const key = subjectKey(from.name);
  if (key)
    tx.insert(categoryAliases)
      .values({ key, tagId: intoId })
      .onConflictDoUpdate({ target: categoryAliases.key, set: { tagId: intoId } })
      .run();
}

export class CategoryConflict extends Error {
  statusCode = 409;
}

/**
 * Renames a tag. If another tag of the same kind already has that name (give or take case and
 * plurals), the tag is merged into it instead. Returns the id that holds the books afterwards.
 */
export function renameTag(tx: Tx, id: string, name: string): string {
  const tag = tx.select().from(tags).where(eq(tags.id, id)).get();
  if (!tag) throw new CategoryConflict("Unknown category");
  const other = findTagByKey(tx, name, [tag.kind]);
  if (other && other.id !== id) {
    mergeTag(tx, id, other.id);
    return other.id;
  }
  tx.update(tags).set({ name }).where(eq(tags.id, id)).run();
  const oldKey = subjectKey(tag.name);
  const newKey = subjectKey(name);
  // The new name is now this tag's own; an alias sending it elsewhere would fight it.
  tx.delete(categoryAliases).where(eq(categoryAliases.key, newKey)).run();
  if (oldKey && oldKey !== newKey)
    tx.insert(categoryAliases)
      .values({ key: oldKey, tagId: id })
      .onConflictDoUpdate({ target: categoryAliases.key, set: { tagId: id } })
      .run();
  return id;
}

export function setHidden(tx: Tx, tagId: string, hidden: boolean, now = Date.now()): void {
  tx.insert(categoryPrefs)
    .values({ tagId, hidden, updatedAt: now })
    .onConflictDoUpdate({ target: categoryPrefs.tagId, set: { hidden, updatedAt: now } })
    .run();
}

/** Subquery of the tag ids an admin hid, for `notInArray`. */
export function hiddenTagIds(db: Pick<Db, "select">) {
  return db.select({ id: categoryPrefs.tagId }).from(categoryPrefs).where(eq(categoryPrefs.hidden, true));
}

export function getMinBooks(db: Pick<Db, "select">): number {
  const v = db.select({ value: settings.value }).from(settings).where(eq(settings.key, MIN_BOOKS_KEY)).get()?.value;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : DEFAULT_MIN_BOOKS;
}

export function setMinBooks(db: Pick<Db, "insert">, n: number, now = Date.now()): void {
  db.insert(settings)
    .values({ key: MIN_BOOKS_KEY, value: n, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: n, updatedAt: now } })
    .run();
}

/** Subject names per book, from the `subject` tags. */
function subjectsByBook(tx: Tx, bookIds?: string[]): Map<string, string[]> {
  const rows = tx
    .select({ bookId: bookTags.bookId, name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(and(eq(tags.kind, "subject"), bookIds ? inArray(bookTags.bookId, bookIds) : undefined))
    .all();
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.bookId) ?? [];
    list.push(r.name);
    out.set(r.bookId, list);
  }
  return out;
}

export interface RebuildReport {
  books: number;
  linked: number;
}

/** Re-files every book from its subject tags (only adds; admin choices and aliases are respected). */
export function rebuildCategories(db: Db): RebuildReport {
  return db.transaction((tx) => {
    const bySubject = subjectsByBook(tx);
    let linked = 0;
    for (const [bookId, subjects] of bySubject) linked += linkCategories(tx, bookId, subjects);
    return { books: bySubject.size, linked };
  });
}

export interface UpgradeReport {
  /** Old genre tags kept as subjects. */
  subjects: number;
  /** Near-duplicate subjects merged ("fantasy" into "Fantasy"). */
  merged: number;
  /** New book → category links. */
  linked: number;
}

/**
 * One-time clean-up for libraries scanned before categories were curated: every old `genre` tag
 * becomes a `subject` (near-duplicates merged), then each book is filed under curated categories
 * from its subjects. Book links are moved, never dropped.
 * Runs once (tracked in settings); returns null when there was nothing to do.
 */
export function upgradeCategories(db: Db, now = Date.now()): UpgradeReport | null {
  const done = db.select({ value: settings.value }).from(settings).where(eq(settings.key, VERSION_KEY)).get()?.value;
  if (typeof done === "number" && done >= TAXONOMY_VERSION) return null;
  const report = db.transaction((tx) => {
    const r: UpgradeReport = { subjects: 0, merged: 0, linked: 0 };
    // 1. Every old genre tag was a raw subject: keep it as one. Curated categories are made fresh
    //    in step 3, so a fiction book with the subject "History" lands in Historical Fiction.
    const oldGenres = tx.select().from(tags).where(eq(tags.kind, "genre")).all();
    for (const t of oldGenres) {
      const clash = tx.select({ id: tags.id }).from(tags).where(and(eq(tags.name, t.name), eq(tags.kind, "subject"))).get();
      if (clash) mergeTag(tx, t.id, clash.id);
      else tx.update(tags).set({ kind: "subject" }).where(eq(tags.id, t.id)).run();
      r.subjects++;
    }

    // 2. Near-duplicate subjects ("Fantasy fiction"/"fantasy fiction", "Dragon"/"Dragons") become one.
    const subjects = tx
      .select({ id: tags.id, name: tags.name, n: sql<number>`(select count(*) from book_tags where tag_id = ${tags.id})` })
      .from(tags)
      .where(eq(tags.kind, "subject"))
      .all();
    const groups = new Map<string, typeof subjects>();
    for (const s of subjects) {
      const key = subjectKey(s.name);
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Keep the most used spelling, preferring one that starts with a capital.
      group.sort((a, b) => b.n - a.n || Number(/^[A-Z]/.test(b.name)) - Number(/^[A-Z]/.test(a.name)));
      for (const dupe of group.slice(1)) {
        // Same key, so no alias is needed: ensureTag finds the survivor by key.
        moveLinks(tx, dupe.id, group[0]!.id);
        tx.delete(tags).where(eq(tags.id, dupe.id)).run();
        r.merged++;
      }
    }

    // 3. File every book under curated categories from its subjects.
    for (const [bookId, names] of subjectsByBook(tx)) r.linked += linkCategories(tx, bookId, names);

    tx.insert(settings)
      .values({ key: VERSION_KEY, value: TAXONOMY_VERSION, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: TAXONOMY_VERSION, updatedAt: now } })
      .run();
    return r;
  });
  return report;
}
