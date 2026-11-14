/**
 * Tables owned by Discover (ws/discover): admin category choices that must survive a rescan.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tags } from "../db/schema.js";

/** Categories an admin hid from the Categories page (the books keep the tag). */
export const categoryPrefs = sqliteTable("category_prefs", {
  tagId: text("tag_id")
    .primaryKey()
    .references(() => tags.id, { onDelete: "cascade" }),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`),
});

/**
 * Names an admin merged or renamed away: any subject or category whose `subjectKey` matches
 * goes to `tagId` instead, so a rescan doesn't bring the old name back.
 */
export const categoryAliases = sqliteTable("category_aliases", {
  key: text("key").primaryKey(),
  tagId: text("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`),
});
