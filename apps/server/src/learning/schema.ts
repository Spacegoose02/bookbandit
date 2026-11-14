/**
 * Tables owned by the read-aloud workstream (word help and quizzes). Additive; drizzle-kit reads
 * this file alongside db/schema.ts (see drizzle.config.ts).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { books, households, users } from "../db/schema.js";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());

/**
 * The family's own word meanings: written by a parent, or saved from Barnaby's answer the first
 * time a kid asked, so the next kid gets it instantly and offline. Parents can edit either kind.
 */
export const learningWords = sqliteTable(
  "learning_words",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    word: text("word").notNull(),
    meaning: text("meaning").notNull(),
    example: text("example"),
    source: text("source", { enum: ["family", "ai"] }).notNull(),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("learning_words_household_word_idx").on(t.householdId, t.word)],
);

/** Every word a reader tapped, for the parent dashboard ("words Emma looked up"). */
export const learningLookups = sqliteTable(
  "learning_lookups",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
    word: text("word").notNull(),
    source: text("source", { enum: ["dictionary", "family", "ai", "none"] }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("learning_lookups_user_idx").on(t.userId, t.createdAt)],
);

export interface QuizQuestion {
  q: string;
  choices: string[];
  answer: number;
  /** The kid's first pick, once answered. */
  picked?: number;
}

/** Three questions after a chapter, made from that chapter's text. Logged for parents. */
export const learningQuizzes = sqliteTable(
  "learning_quizzes",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** The EPUB spine item (zip path) the questions come from. */
    section: text("section").notNull(),
    chapterLabel: text("chapter_label"),
    questions: text("questions", { mode: "json" }).$type<QuizQuestion[]>().notNull(),
    source: text("source", { enum: ["ai", "offline"] }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    completedAt: integer("completed_at", { mode: "number" }),
    score: integer("score"),
  },
  (t) => [index("learning_quizzes_user_idx").on(t.userId, t.createdAt)],
);
