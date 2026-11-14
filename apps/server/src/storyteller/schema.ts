/**
 * Tables owned by the listening/storyteller workstream. Additive; drizzle-kit reads this file
 * alongside db/schema.ts (see drizzle.config.ts).
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { STORYTELLER_MODES } from "@bookbandit/shared";
import { books, users } from "../db/schema.js";

/** A parent's storyteller rules for one kid. No row = storyteller off, no limits. */
export const storytellerSettings = sqliteTable("storyteller_settings", {
  kidId: text("kid_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  storiesPerNight: integer("stories_per_night"),
  minutesPerNight: integer("minutes_per_night"),
  sleepTimerMinutes: integer("sleep_timer_minutes"),
  readAloud: integer("read_aloud", { mode: "boolean" }).notNull().default(true),
  timeZone: text("time_zone").notNull().default("UTC"),
  nightStartsHour: integer("night_starts_hour").notNull().default(12),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

/**
 * One story played in storyteller mode. Listening time is credited by the server from
 * heartbeats (wall clock, capped per beat), never taken from the client's word.
 */
export const storytellerSessions = sqliteTable(
  "storyteller_sessions",
  {
    id: text("id").primaryKey(),
    kidId: text("kid_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: STORYTELLER_MODES }).notNull(),
    /** The night this story counts toward (nightKey at start). */
    night: text("night").notNull(),
    startedAt: integer("started_at", { mode: "number" }).notNull(),
    lastBeatAt: integer("last_beat_at", { mode: "number" }).notNull(),
    endedAt: integer("ended_at", { mode: "number" }),
    /** The player reached the end of the story (a finished story can't be "resumed" past a limit). */
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    listenedMs: integer("listened_ms").notNull().default(0),
  },
  (t) => [index("storyteller_sessions_kid_night_idx").on(t.kidId, t.night)],
);
