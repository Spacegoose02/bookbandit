/**
 * Tables owned by the integrations workstream (Audiobookshelf, Send to Kindle).
 * Kept additive; drizzle-kit reads this file alongside db/schema.ts.
 */
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { books, users } from "../db/schema.js";

/**
 * Per-person audiobook position. Separate from reading_progress so listening to the
 * audiobook never overwrites where someone is in the ebook of the same work.
 */
export const audioProgress = sqliteTable(
  "audio_progress",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** The Audiobookshelf item the position refers to (a relink resets the position). */
    absItemId: text("abs_item_id").notNull(),
    currentTime: real("position_seconds").notNull().default(0),
    duration: real("duration_seconds").notNull().default(0),
    finished: integer("finished", { mode: "boolean" }).notNull().default(false),
    deviceName: text("device_name"),
    clientUpdatedAt: integer("client_updated_at", { mode: "number" }).notNull(),
    serverUpdatedAt: integer("server_updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] }), index("audio_progress_user_idx").on(t.userId, t.serverUpdatedAt)],
);

/** A person's Send to Kindle address. Kids' addresses can only be set by a parent or admin. */
export const kindleAddresses = sqliteTable("kindle_addresses", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  setBy: text("set_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});
