/**
 * Bookbandit data model (SQLite via Drizzle).
 *
 * Conventions:
 * - ids are text UUIDs (crypto.randomUUID()).
 * - timestamps are integer milliseconds since epoch (`ms` helper).
 * - Books are files on disk under /books; this database can be rebuilt by rescanning,
 *   except for people, progress, bookmarks and ratings set by an admin.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { CONTENT_RATINGS, KID_SIGN_IN_METHODS, ROLES, type BookLockField } from "@bookbandit/shared";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const ms = (name: string) => integer(name, { mode: "number" });
const createdAt = () => ms("created_at").notNull().default(sql`(unixepoch() * 1000)`);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const households = sqliteTable("households", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

/** A person: adult or kid. Kids are always linked to at least one parent (see parentLinks). */
export const users = sqliteTable(
  "users",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    /** Kids: required to compute their content limit. Adults: optional. */
    birthYear: integer("birth_year"),
    /** Adults opt in to explicit content themselves; ignored for kids. */
    explicitOptIn: integer("explicit_opt_in", { mode: "boolean" }).notNull().default(false),
    avatar: text("avatar"),
    theme: text("theme").notNull().default("dark"),
    /** Kids: how they sign in. Null for adults (they use Tinyauth/Google or local password). */
    kidSignInMethod: text("kid_sign_in_method", { enum: KID_SIGN_IN_METHODS }),
    /** scrypt hash for local password or kid PIN. */
    secretHash: text("secret_hash"),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("users_household_idx").on(t.householdId)],
);

/** Emails that sign this user in through Tinyauth (one user may link several). */
export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["tinyauth", "local"] }).notNull(),
    /** Lower-cased email for tinyauth, username for local. */
    subject: text("subject").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_identities_subject_idx").on(t.provider, t.subject)],
);

/** Parent ↔ kid links. Only a parent or admin can create or remove these. */
export const parentLinks = sqliteTable(
  "parent_links",
  {
    parentId: text("parent_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kidId: text("kid_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.parentId, t.kidId] })],
);

/** Long-lived tokens for paired tablets (QR pairing) and API clients. */
export const devices = sqliteTable(
  "devices",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** When set, the device is locked to this user (e.g. a kid's own tablet). */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    lastSeenAt: ms("last_seen_at"),
    revokedAt: ms("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("devices_token_idx").on(t.tokenHash)],
);

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const authors = sqliteTable(
  "authors",
  {
    id: id(),
    name: text("name").notNull(),
    sortName: text("sort_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("authors_name_idx").on(t.name)],
);

export const series = sqliteTable("series", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  /** true when an admin made or edited it; metadata refresh won't overwrite it. */
  adminManaged: integer("admin_managed", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

/** A work: one book regardless of how many files/formats/audio editions it has. */
export const books = sqliteTable(
  "books",
  {
    id: id(),
    title: text("title").notNull(),
    sortTitle: text("sort_title").notNull(),
    /** The title it was first published under, when different (translations, renamed editions). */
    originalTitle: text("original_title"),
    subtitle: text("subtitle"),
    description: text("description"),
    language: text("language"),
    publishedYear: integer("published_year"),
    isbn13: text("isbn13"),
    publisher: text("publisher"),
    coverPath: text("cover_path"),
    pageCount: integer("page_count"),
    /** Null = unrated = treated as adult until reviewed (fail closed). */
    rating: text("rating", { enum: CONTENT_RATINGS }),
    ratingSource: text("rating_source", {
      enum: ["admin", "folder", "metadata", "ai", "keywords"],
    }),
    /** Ingest inbox: not visible to non-admins until approved. */
    approved: integer("approved", { mode: "boolean" }).notNull().default(false),
    /** Owned on Kindle only (metadata entry, no file). */
    kindleOnly: integer("kindle_only", { mode: "boolean" }).notNull().default(false),
    kindleAsin: text("kindle_asin"),
    /** Audiobookshelf library item id, when linked. */
    absItemId: text("abs_item_id"),
    hardcoverId: text("hardcover_id"),
    openLibraryId: text("open_library_id"),
    googleBooksId: text("google_books_id"),
    /**
     * Fields an admin locked (BOOK_LOCK_FIELDS): metadata refresh, rescans, Calibre imports and the
     * auto-categorizer leave them alone. Editing a field in the book editor locks it.
     */
    lockedFields: text("locked_fields", { mode: "json" }).$type<BookLockField[]>().notNull().default(sql`'[]'`),
    addedAt: createdAt(),
    updatedAt: ms("updated_at"),
  },
  (t) => [
    index("books_rating_idx").on(t.rating),
    index("books_isbn_idx").on(t.isbn13),
    index("books_sort_idx").on(t.sortTitle),
    // "Recently added" lists.
    index("books_added_idx").on(t.addedAt),
  ],
);

export const bookAuthors = sqliteTable(
  "book_authors",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => authors.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("author"),
    position: integer("position").notNull().default(0),
  },
  // author_idx: author pages and author lists (ws/ops, 20k-book performance pass).
  (t) => [primaryKey({ columns: [t.bookId, t.authorId, t.role] }), index("book_authors_author_idx").on(t.authorId)],
);

export const bookSeries = sqliteTable(
  "book_series",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    /** Allows 1, 1.5, 2 … */
    position: real("position"),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.seriesId] }), index("book_series_series_idx").on(t.seriesId)],
);

export const BOOK_FORMATS = ["epub", "kepub", "mobi", "azw3", "fb2", "pdf", "cbz", "cbr", "txt"] as const;

/** A file on disk for a book. Paths are relative to the /books root. */
export const bookFiles = sqliteTable(
  "book_files",
  {
    id: id(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    relPath: text("rel_path").notNull(),
    format: text("format", { enum: BOOK_FORMATS }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256"),
    mtimeMs: ms("mtime_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("book_files_path_idx").on(t.relPath),
    index("book_files_hash_idx").on(t.sha256),
    // "Has a file" checks (OPDS, Kobo) and files-per-book lookups.
    index("book_files_book_idx").on(t.bookId),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: id(),
    name: text("name").notNull(),
    /**
     * genre = a curated category (discover/taxonomy.ts); subject = a raw metadata subject, kept for
     * search and Barnaby but not listed as a category; section = drives a home shelf (kids,
     * cookbook); custom = user tag
     */
    kind: text("kind", { enum: ["genre", "subject", "section", "custom"] }).notNull().default("genre"),
  },
  (t) => [uniqueIndex("tags_name_idx").on(t.name, t.kind)],
);

export const bookTags = sqliteTable(
  "book_tags",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.tagId] }), index("book_tags_tag_idx").on(t.tagId)],
);

export const collections = sqliteTable("collections", {
  id: id(),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** null = shared with the household */
  ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const collectionBooks = sqliteTable(
  "collection_books",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.bookId] })],
);

/** Books a parent put on a kid's shelf by hand. Still subject to the content lock. */
export const kidShelf = sqliteTable(
  "kid_shelf",
  {
    kidId: text("kid_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** Shown in toddler storyteller mode */
    storyteller: integer("storyteller", { mode: "boolean" }).notNull().default(false),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.kidId, t.bookId] })],
);

// ---------------------------------------------------------------------------
// Reading state (per user, synced across devices)
// ---------------------------------------------------------------------------

export const readingProgress = sqliteTable(
  "reading_progress",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** JSON-encoded ReadingLocator from @bookbandit/shared */
    locator: text("locator", { mode: "json" }).notNull(),
    percent: real("percent").notNull().default(0),
    finished: integer("finished", { mode: "boolean" }).notNull().default(false),
    deviceName: text("device_name"),
    clientUpdatedAt: ms("client_updated_at").notNull(),
    serverUpdatedAt: ms("server_updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] })],
);

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["bookmark", "highlight", "sticker"] }).notNull(),
    locator: text("locator", { mode: "json" }).notNull(),
    text: text("text"),
    note: text("note"),
    color: text("color"),
    createdAt: createdAt(),
    /**
     * Bumped on every insert, edit and soft delete; the cursor for incremental sync.
     * Constant default because SQLite can't ALTER TABLE ADD COLUMN with an expression default;
     * the sync routes always set it.
     */
    updatedAt: ms("updated_at").notNull().default(0),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    index("bookmarks_user_book_idx").on(t.userId, t.bookId),
    index("bookmarks_user_updated_idx").on(t.userId, t.updatedAt),
  ],
);

/**
 * Time spent reading or listening, for the parent dashboard and reading streaks.
 * Clients send heartbeats with small deltas; the server caps each delta by the wall-clock
 * time since the previous beat, so a stuck or tampered client can't inflate the total.
 */
export const readingSessions = sqliteTable(
  "reading_sessions",
  {
    /** Client-chosen UUID, one per open book. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["read", "listen"] }).notNull().default("read"),
    deviceName: text("device_name"),
    startedAt: ms("started_at").notNull(),
    lastBeatAt: ms("last_beat_at").notNull(),
    seconds: integer("seconds").notNull().default(0),
  },
  (t) => [index("reading_sessions_user_started_idx").on(t.userId, t.startedAt)],
);

// ---------------------------------------------------------------------------
// Requests, jobs, AI
// ---------------------------------------------------------------------------

export const bookRequests = sqliteTable("book_requests", {
  id: id(),
  requestedBy: text("requested_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  author: text("author"),
  isbn13: text("isbn13"),
  /** Rating guessed at request time; kid requests above their limit are auto-declined. */
  rating: text("rating", { enum: CONTENT_RATINGS }),
  status: text("status", {
    enum: ["pending", "approved", "declined", "downloading", "done", "failed"],
  })
    .notNull()
    .default("pending"),
  decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
  note: text("note"),
  createdAt: createdAt(),
  updatedAt: ms("updated_at"),
  // Added by ws/requests (see apps/server/src/requests/README.md).
  /** Cover and year from the search result the request was made from, for display. */
  coverUrl: text("cover_url"),
  publishedYear: integer("published_year"),
  /** Why `rating` was guessed (e.g. 'genre "Young Adult"'); shown to the approver. */
  ratingReason: text("rating_reason"),
  decidedAt: ms("decided_at"),
  /** The download job working on this request, if any. */
  jobId: text("job_id"),
  /** The library book the download became (still subject to the content lock when shown). */
  bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
});

/** Background job queue (scan, metadata, convert, download, send-to-kindle, ai). */
export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: ms("run_after").notNull().default(sql`(unixepoch() * 1000)`),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: ms("finished_at"),
    // Added by ws/requests for the job runner (apps/server/src/jobs).
    /** Short human label for the admin jobs list, e.g. "Download: The Hobbit". */
    label: text("label"),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** 0..1 while running, when the handler reports it. */
    progress: real("progress"),
    /** What the handler returned (JSON). */
    result: text("result", { mode: "json" }),
    startedAt: ms("started_at"),
    updatedAt: ms("updated_at"),
  },
  (t) => [index("jobs_status_idx").on(t.status, t.runAfter)],
);

/** Kid AI chats are always logged for the parent dashboard. */
export const aiMessages = sqliteTable(
  "ai_messages",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    /** Set when the moderation layer blocked or rewrote this message */
    moderation: text("moderation"),
    provider: text("provider"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_messages_user_idx").on(t.userId, t.createdAt)],
);

/** Key/value settings (AI providers, SMTP, integrations). Secrets are stored encrypted. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: ms("updated_at"),
});
