/**
 * Tables owned by the e-reader workstream (OPDS, KOReader sync, Kobo sync).
 * Kept additive; drizzle-kit reads this file alongside db/schema.ts.
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bookFiles, books, households, users } from "../db/schema.js";

export const EREADER_CREDENTIAL_KINDS = ["login", "kobo"] as const;
export type EreaderCredentialKind = (typeof EREADER_CREDENTIAL_KINDS)[number];

/**
 * Sign-ins for e-readers, which can't do Tinyauth or a QR pairing.
 *
 * - `login`: a username and a server-generated password, for OPDS (HTTP Basic) and KOReader
 *   sync. `secret_hash` is sha256(md5hex(password)) because KOReader sends md5(password).
 * - `kobo`: a token that goes in the Kobo's `api_endpoint` URL. `secret_hash` is sha256(token).
 *
 * Every request made with one of these acts as `user_id`, through the same content lock.
 * A kid's credential can only be created or revoked by a linked parent or an admin.
 */
export const ereaderCredentials = sqliteTable(
  "ereader_credentials",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: EREADER_CREDENTIAL_KINDS }).notNull(),
    /** Shown in the list, e.g. "Kobo Clara" or "KOReader on the Kindle". */
    name: text("name").notNull(),
    /** `login` only: lower-case, unique. */
    username: text("username"),
    secretHash: text("secret_hash").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("ereader_credentials_username_idx").on(t.username),
    uniqueIndex("ereader_credentials_secret_idx").on(t.secretHash),
    index("ereader_credentials_user_idx").on(t.userId),
  ],
);

/**
 * KOReader's identifiers for a file: the partial MD5 it computes by default ("binary"
 * document matching) and the MD5 of the file name ("filename" matching). Rebuildable: it's
 * recomputed whenever the file's size or mtime changes.
 */
export const fileDigests = sqliteTable(
  "ereader_file_digests",
  {
    fileId: text("file_id")
      .primaryKey()
      .references(() => bookFiles.id, { onDelete: "cascade" }),
    partialMd5: text("partial_md5").notNull(),
    nameMd5: text("name_md5").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mtimeMs: integer("mtime_ms", { mode: "number" }),
  },
  (t) => [index("ereader_file_digests_partial_idx").on(t.partialMd5), index("ereader_file_digests_name_idx").on(t.nameMd5)],
);

/**
 * KOReader's own progress records, exactly as the device sent them, keyed by its document id.
 * Kept even for files that aren't in the library (a book sideloaded onto the e-reader), so
 * the sync works like any kosync server. Positions in library books are also written to
 * reading_progress so the web reader and other devices see them.
 */
export const koreaderProgress = sqliteTable(
  "koreader_progress",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    document: text("document").notNull(),
    progress: text("progress").notNull(),
    percentage: real("percentage").notNull(),
    device: text("device").notNull(),
    deviceId: text("device_id").notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.document] })],
);

/** What a Kobo has been sent, so the next sync only sends changes and removals. */
export const koboSyncedBooks = sqliteTable(
  "kobo_synced_books",
  {
    credentialId: text("credential_id")
      .notNull()
      .references(() => ereaderCredentials.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** Server ms when the metadata was last sent. */
    syncedAt: integer("synced_at", { mode: "number" }).notNull(),
    /** The person removed it on the Kobo; don't send it again until it changes. */
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.credentialId, t.bookId] })],
);

/** The Kobo's last reading state per book, kept verbatim so its exact bookmark round-trips. */
export const koboReadingStates = sqliteTable(
  "kobo_reading_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** JSON: the CurrentBookmark, StatusInfo and Statistics objects the Kobo sent. */
    state: text("state", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] })],
);
