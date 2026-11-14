/**
 * Tables owned by the audio workstream (ws/audio): local audiobooks scanned from
 * AUDIOBOOKS_DIR, listening bookmarks and per-book player settings, and each person's
 * Audiobookshelf account for importing progress and writing positions back.
 *
 * Additive; drizzle-kit reads this file alongside db/schema.ts (see drizzle.config.ts).
 * `audiobooks` is a cache of the folders on disk and is rebuilt by rescanning; bookmarks,
 * player settings and ABS accounts are people's data and are not.
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { books, users } from "../db/schema.js";

/** One audio file of a local audiobook, in play order. Paths are relative to AUDIOBOOKS_DIR. */
export interface LocalTrack {
  relPath: string;
  /** Seconds. */
  duration: number;
  /** Where this file starts in the whole book, in seconds. */
  startOffset: number;
  mimeType: string;
  sizeBytes: number;
  mtimeMs: number;
  title: string;
}

export interface LocalChapter {
  start: number;
  end: number;
  title: string;
}

/** A folder (or single file) under AUDIOBOOKS_DIR that is one audiobook, attached to a book. */
export const audiobooks = sqliteTable(
  "audiobooks",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** The book's folder (or the file, for a loose single-file audiobook), relative to AUDIOBOOKS_DIR. */
    relPath: text("rel_path").notNull(),
    /** Changes when any file is added, removed, resized or touched; an unchanged folder is skipped. */
    signature: text("signature").notNull(),
    tracks: text("tracks", { mode: "json" }).$type<LocalTrack[]>().notNull(),
    chapters: text("chapters", { mode: "json" }).$type<LocalChapter[]>().notNull(),
    duration: real("duration_seconds").notNull().default(0),
    narrator: text("narrator"),
    /** Cover inside the folder (cover.jpg, folder.png …), relative to AUDIOBOOKS_DIR. */
    coverRelPath: text("cover_rel_path"),
    createdAt: integer("created_at", { mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("audiobooks_path_idx").on(t.relPath), index("audiobooks_book_idx").on(t.bookId)],
);

/** A listening bookmark with an optional note. Soft-deleted so other devices see the delete. */
export const audioBookmarks = sqliteTable(
  "audio_bookmarks",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** Seconds into the whole book. */
    time: real("time_seconds").notNull(),
    note: text("note"),
    /** "bookbandit" or "audiobookshelf" (imported). */
    origin: text("origin", { enum: ["bookbandit", "audiobookshelf"] }).notNull().default("bookbandit"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "number" }),
  },
  (t) => [index("audio_bookmarks_user_book_idx").on(t.userId, t.bookId)],
);

/** Per person, per book player settings: speed is remembered per book. */
export const audioPrefs = sqliteTable(
  "audio_prefs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    speed: real("speed").notNull().default(1),
    skipSilence: integer("skip_silence", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] })],
);

/**
 * A person's own Audiobookshelf account (an ABS API key made for that ABS user). Used to import
 * their progress and bookmarks and to write their listening position back. Admin-managed.
 */
export const absAccounts = sqliteTable("abs_accounts", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  absUserId: text("abs_user_id").notNull(),
  absUsername: text("abs_username").notNull(),
  /** Sealed with the integrations SecretBox; never sent to clients. */
  tokenSealed: text("token_sealed").notNull(),
  /** Push positions to ABS while listening in Bookbandit. */
  writeBack: integer("write_back", { mode: "boolean" }).notNull().default(true),
  lastImportAt: integer("last_import_at", { mode: "number" }),
  lastPushAt: integer("last_push_at", { mode: "number" }),
  lastError: text("last_error"),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});
