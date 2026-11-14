/**
 * Tables owned by the imports workstream (ws/migrate): moving in from Calibre, Calibre-Web,
 * Kavita, Goodreads, StoryGraph and Google Play Books.
 *
 * - `reading_history`: what a person read, when, and how they liked it. Rows can point at a
 *   library book or stand alone (a Goodreads "read" shelf has many books the family doesn't own),
 *   so the history survives and exports back out complete.
 * - `book_identifiers`: outside ids for a book (Calibre's `goodreads`, `amazon`, … identifiers,
 *   Google Play volume ids). Used to match later imports and for the "also on" links.
 * - `import_links`: which library book an outside record became (Calibre book 42 → our id), so
 *   re-running an import updates instead of duplicating, and Calibre-Web can follow Calibre.
 *
 * Like people and progress, these are not rebuilt by a rescan.
 */
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { books, users } from "../db/schema.js";

export const READING_STATUSES = ["read", "reading", "to-read", "did-not-finish"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const IMPORT_SOURCES = ["calibre", "calibre-web", "kavita", "goodreads", "storygraph", "google-play", "bookbandit"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const readingHistory = sqliteTable(
  "reading_history",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The library book, when we have it. Null keeps history of books the family doesn't own. */
    bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    author: text("author"),
    isbn13: text("isbn13"),
    status: text("status", { enum: READING_STATUSES }).notNull(),
    /** Star rating 0.5..5 the person gave; null = not rated. Not the content (age) rating. */
    stars: real("stars"),
    review: text("review"),
    /** Shelves from the source other than the status one (Goodreads "favorites", StoryGraph tags). */
    shelves: text("shelves", { mode: "json" }).$type<string[]>(),
    readCount: integer("read_count").notNull().default(0),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
    /** When it went on a shelf at the source. */
    addedAt: integer("added_at", { mode: "number" }),
    source: text("source", { enum: IMPORT_SOURCES }).notNull(),
    /** Stable key within the source (Goodreads Book Id, StoryGraph ISBN/UID, or title|author). */
    sourceKey: text("source_key").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("reading_history_source_idx").on(t.userId, t.source, t.sourceKey),
    index("reading_history_user_idx").on(t.userId, t.finishedAt),
    index("reading_history_book_idx").on(t.bookId),
  ],
);

export const bookIdentifiers = sqliteTable(
  "book_identifiers",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** Lower-case type as Calibre names them: isbn, goodreads, amazon, google, google-play, kavita … */
    type: text("type").notNull(),
    value: text("value").notNull(),
  },
  (t) => [uniqueIndex("book_identifiers_idx").on(t.bookId, t.type), index("book_identifiers_value_idx").on(t.type, t.value)],
);

export const importLinks = sqliteTable(
  "import_links",
  {
    source: text("source", { enum: IMPORT_SOURCES }).notNull(),
    /** e.g. "<calibre library uuid>:42" */
    sourceId: text("source_id").notNull(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("import_links_idx").on(t.source, t.sourceId), index("import_links_book_idx").on(t.bookId)],
);
