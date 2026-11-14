/**
 * Tables owned by the Barnaby AI workstream. Kept additive; drizzle-kit reads this file
 * alongside db/schema.ts. Messages themselves live in `ai_messages` (db/schema.ts).
 */
import { sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CONTENT_RATINGS } from "@bookbandit/shared";
import { aiMessages, books, users } from "../db/schema.js";

const createdAt = () => integer("created_at", { mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`);

/** One chat with Barnaby. `bookId` set = a spoiler-free chat about that book. */
export const aiConversations = sqliteTable(
  "ai_conversations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** True when the person was a kid at the time: the chat is in the parent log and can't be deleted by them. */
    kid: integer("kid", { mode: "boolean" }).notNull().default(false),
    /** Set when moderation blocked or rewrote any message, so parents can spot it in the log. */
    flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("ai_conversations_user_idx").on(t.userId, t.updatedAt)],
);

/** Web results and library books cited by an assistant message. Book refs are re-checked against the content lock on read. */
export const aiMessageSources = sqliteTable(
  "ai_message_sources",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => aiMessages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: text("kind", { enum: ["web", "book"] }).notNull(),
    title: text("title").notNull(),
    url: text("url"),
    bookId: text("book_id").references(() => books.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.position] })],
);

/**
 * What a parent allows for one kid. No row = Barnaby is off for that kid. Only a linked
 * parent or an admin can write this (CLAUDE.md rule 2).
 */
export const aiKidSettings = sqliteTable("ai_kid_settings", {
  kidId: text("kid_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** SearXNG strict safe search, allowlisted sites only. */
  webSearch: integer("web_search", { mode: "boolean" }).notNull().default(false),
  /** Messages the kid may send per day. */
  dailyLimit: integer("daily_limit").notNull().default(30),
  setBy: text("set_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().default(0),
});

/** One row per provider call, for the admin usage view. */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    feature: text("feature").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_created_idx").on(t.createdAt)],
);

/**
 * Rating helper suggestions for the admin review queue. A suggestion never makes a book
 * visible to more people on its own: an admin accepts it, or it's applied automatically
 * only when it's stricter than the current rating.
 */
export const aiRatingSuggestions = sqliteTable("ai_rating_suggestions", {
  bookId: text("book_id")
    .primaryKey()
    .references(() => books.id, { onDelete: "cascade" }),
  rating: text("rating", { enum: CONTENT_RATINGS }).notNull(),
  confidence: real("confidence").notNull(),
  reasons: text("reasons").notNull(),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  /** pending → accepted (admin), applied (auto, stricter), dismissed */
  status: text("status", { enum: ["pending", "accepted", "applied", "dismissed"] }).notNull().default("pending"),
  createdAt: createdAt(),
});

// ---- Round 2: meaning search and metadata cleanup ---------------------------------

/**
 * One embedding per book for meaning search and "more like this". Rebuildable at any time from
 * the books table (the `ai.embed` job), so it's a cache, not data. `textHash` spots stale rows.
 */
export const aiBookEmbeddings = sqliteTable(
  "ai_book_embeddings",
  {
    bookId: text("book_id")
      .primaryKey()
      .references(() => books.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    dims: integer("dims").notNull(),
    /** Float32 little-endian, unit length. */
    vector: blob("vector", { mode: "buffer" }).notNull(),
    textHash: text("text_hash").notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("ai_book_embeddings_model_idx").on(t.model)],
);

/**
 * Metadata cleanup suggestions, one row per book and field. An admin accepts each field on its
 * own; nothing is changed without that.
 */
export const aiMetadataSuggestions = sqliteTable(
  "ai_metadata_suggestions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    field: text("field", { enum: ["title", "subtitle", "authors", "series", "description"] }).notNull(),
    /** JSON: string for text fields, string[] for authors, { name, position } for series. */
    current: text("current", { mode: "json" }),
    suggested: text("suggested", { mode: "json" }).notNull(),
    reason: text("reason").notNull().default(""),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["pending", "accepted", "dismissed"] }).notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ai_metadata_suggestions_book_field_idx").on(t.bookId, t.field), index("ai_metadata_suggestions_status_idx").on(t.status)],
);

/** Books the metadata helper has looked at, so a run only picks new ones. */
export const aiMetadataChecks = sqliteTable("ai_metadata_checks", {
  bookId: text("book_id")
    .primaryKey()
    .references(() => books.id, { onDelete: "cascade" }),
  checkedAt: integer("checked_at", { mode: "number" }).notNull(),
});
