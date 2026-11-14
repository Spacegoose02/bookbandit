/**
 * Tables owned by the read-aloud workstream (narration). Additive; drizzle-kit reads this file
 * alongside db/schema.ts (see drizzle.config.ts).
 */
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "../db/schema.js";

/** A person's read-aloud voice and speed. No row = the server's default voice at 1.0×. */
export const narrationPrefs = sqliteTable("narration_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  voice: text("voice"),
  speed: real("speed").notNull().default(1),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});
