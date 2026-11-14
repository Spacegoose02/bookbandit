/**
 * Tables owned by the kids workstream (goals, badges, stickers, reading bedtime). Additive;
 * drizzle-kit reads this file alongside db/schema.ts (see drizzle.config.ts).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { books, users } from "../db/schema.js";

/** A parent's reading goal for one kid. No row = no goal. */
export const readingGoals = sqliteTable("reading_goals", {
  kidId: text("kid_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  minutesPerDay: integer("minutes_per_day"),
  booksPerMonth: integer("books_per_month"),
  timeZone: text("time_zone").notNull().default("UTC"),
  /** Days before this (local date, YYYY-MM-DD) don't earn goal stickers. */
  startsOn: text("starts_on").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

/** Reading bedtime for one kid. No row = no bedtime. Enforced by the guard in index.ts. */
export const readingBedtimes = sqliteTable("reading_bedtimes", {
  kidId: text("kid_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  weekendStartMinute: integer("weekend_start_minute"),
  timeZone: text("time_zone").notNull().default("UTC"),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

/**
 * Badges (one each, `key` = "") and stickers (one per book, goal day or goal month). The server
 * awards them from reading time and finished books; clients can only mark them as seen.
 */
export const rewardAwards = sqliteTable(
  "reward_awards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["badge", "sticker"] }).notNull(),
    /** Badge id, or sticker reason (book, goal_day, goal_month). */
    award: text("award").notNull(),
    /** "" for badges; book id, YYYY-MM-DD or YYYY-MM for stickers. */
    key: text("key").notNull().default(""),
    bookId: text("book_id").references(() => books.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    earnedAt: integer("earned_at", { mode: "number" }).notNull(),
    /** The kid saw the celebration. */
    seenAt: integer("seen_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("reward_awards_user_award_key_idx").on(t.userId, t.award, t.key),
    index("reward_awards_user_earned_idx").on(t.userId, t.earnedAt),
  ],
);
