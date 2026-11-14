/**
 * Tables owned by the librarian tools (ws/librarian).
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "../db/schema.js";

/**
 * Duplicate groups an admin marked "not duplicates". The key is the group's sorted book ids
 * joined with ","; when the group changes (a third copy appears) the key changes and it shows again.
 */
export const duplicateIgnores = sqliteTable("duplicate_ignores", {
  groupKey: text("group_key").primaryKey(),
  ignoredBy: text("ignored_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`),
});
