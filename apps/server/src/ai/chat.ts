/**
 * One turn of a Barnaby chat: checks, moderation in, context (library, web, book text),
 * the model call, moderation out, and the log.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { aiMessages, bookAuthors, authors, bookFiles, books, readingProgress } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { httpError } from "../auth/plugin.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import type { AiContext } from "./context.js";
import { readTextUpTo } from "./booktext.js";
import { kidAccess, kidSettings, KID_BLOCK_MESSAGES, type KidAccess } from "./kids.js";
import { booksMentioned, libraryContext } from "./library-context.js";
import { kidSafeReply, moderate, type ModerationResult } from "./moderation.js";
import { redactPersonalDetails, stripUnlistedLinks } from "./privacy.js";
import { systemPrompt } from "./prompts.js";
import { makeProvider, type AiProvider, type ChatMessage, type ChatResult } from "./providers/index.js";
import { webSearch, type WebSource } from "./search.js";
import { aiConversations, aiMessageSources } from "./schema.js";
import { getAiSettings, providerFor, type AiFeature } from "./settings.js";
import { tracked } from "./usage.js";

export interface ChatInput {
  message: string;
  conversationId?: string;
  bookId?: string;
  /** 0..1, the reader's position right now (fresher than the synced one). */
  position?: number;
  webSearch?: boolean;
}

export interface SourceView {
  kind: "web" | "book";
  title: string;
  url?: string | null;
  bookId?: string | null;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  moderation: string | null;
  createdAt: number;
  sources: SourceView[];
}

const HISTORY = 12;

function aiError(statusCode: number, code: string, message: string) {
  return Object.assign(httpError(statusCode, message), { code });
}

export async function chatTurn(ctx: AiContext, reader: Reader, input: ChatInput) {
  const { db } = ctx;
  const now = ctx.now();
  const settings = getAiSettings(db, ctx.box);
  const kid = reader.isKid;

  // Conversation first, so a book chat keeps its book.
  let conv = input.conversationId
    ? db
        .select()
        .from(aiConversations)
        .where(and(eq(aiConversations.id, input.conversationId), eq(aiConversations.userId, reader.userId)))
        .get()
    : undefined;
  if (input.conversationId && !conv) throw httpError(404, "Not found");
  const bookId = conv?.bookId ?? input.bookId ?? null;

  const feature: AiFeature = bookId ? "bookChat" : kid ? "kidChat" : "chat";
  const config = providerFor(settings, kid && bookId ? "kidChat" : feature) ?? providerFor(settings, feature);
  if (!config) throw aiError(503, "not_configured", "Barnaby isn't set up yet. An admin can add an AI provider in settings.");
  const provider = makeProvider(config, ctx.fetchImpl);
  const modConfig = providerFor(settings, "moderation");
  const modProvider = modConfig ? makeProvider(modConfig, ctx.fetchImpl) : null;

  let access: KidAccess | null = null;
  if (kid) {
    access = kidAccess(db, reader, kidSettings(db, reader.userId, settings.kidDefaults), now);
    if (!access.allowed) {
      const reason = access.reason!;
      throw aiError(reason === "daily_limit" ? 429 : 403, reason, KID_BLOCK_MESSAGES[reason]);
    }
  }

  // The book, behind the content lock.
  let book: typeof books.$inferSelect | undefined;
  if (bookId) {
    book = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book, now);
  }

  // Personal details never leave the house (or reach the log) for kids.
  let text = input.message.trim();
  let userNote: string | null = null;
  if (kid) {
    const r = redactPersonalDetails(text);
    text = r.text;
    if (r.removed.length) userNote = `redacted:${r.removed.join(",")}`;
  }

  if (!conv) {
    const title = text.replace(/\s+/g, " ").slice(0, 60) || "Chat";
    conv = db
      .insert(aiConversations)
      .values({ userId: reader.userId, bookId, title: book ? book.title : title, kid, createdAt: now.getTime(), updatedAt: now.getTime() })
      .returning()
      .get();
  }
  const conversation = conv;

  const call = (p: AiProvider, f: string, run: () => Promise<ChatResult>) => tracked(ctx, p, f, reader.userId, run);
  const moderationCall = (p: AiProvider, run: () => Promise<ChatResult>) => call(p, "moderation", run);

  const moderating = kid || settings.moderation.adults;
  const audience = { kid, age: access?.age ?? null };
  if (moderating) {
    const verdict = await moderate(text, { ...audience, direction: "input", provider: modProvider, useWords: kid }, moderationCall);
    if (verdict.flagged) return blocked(ctx, reader, conversation.id, bookId, text, verdict, now, access);
  }

  // Context
  const searchAllowed = settings.search.enabled && !!settings.search.url && (!kid || !!access?.webSearch);
  let web: WebSource[] = [];
  let searchError: string | null = null;
  if (input.webSearch && searchAllowed) {
    try {
      web = await webSearch(ctx.fetchImpl, settings.search, text, { kid });
    } catch (e) {
      searchError = (e as Error).message;
    }
  }
  const library = libraryContext(db, reader, text, bookId ? 6 : 15);

  let bookContext: Parameters<typeof systemPrompt>[0]["book"];
  if (book) {
    const progress = db
      .select({ percent: readingProgress.percent })
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, reader.userId), eq(readingProgress.bookId, book.id)))
      .get();
    const position = input.position ?? progress?.percent ?? 0;
    const files = db.select({ relPath: bookFiles.relPath, format: bookFiles.format }).from(bookFiles).where(eq(bookFiles.bookId, book.id)).all();
    const bookAuthorsList = db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, book.id))
      .all()
      .map((a) => a.name);
    bookContext = {
      title: book.title,
      authors: bookAuthorsList,
      description: book.description,
      excerpt: await readTextUpTo(ctx.booksDir, files, position).catch(() => null),
    };
  }

  const history = recentHistory(db, conversation.id);
  const system = systemPrompt({ name: reader.displayName, kid, age: access?.age ?? null, library, web, book: bookContext, today: now });
  const result = await call(provider, feature, () =>
    provider.chat({ system, messages: [...history, { role: "user", content: text }], maxTokens: kid ? 500 : 1000 }),
  );
  let reply = result.text || "Hmm, I couldn't think of an answer. Could you ask another way?";
  let replyNote: string | null = null;

  if (kid) reply = stripUnlistedLinks(reply, web.map((w) => w.url));
  if (moderating) {
    const verdict = await moderate(reply, { ...audience, direction: "output", provider: modProvider, useWords: kid }, moderationCall);
    if (verdict.flagged) {
      reply = kid ? kidSafeReply(verdict.category, "output") : "Sorry, I can't help with that one.";
      replyNote = `rewritten:${verdict.category ?? "other"}`;
    }
  }

  const sources: SourceView[] = replyNote
    ? []
    : [
        ...web.filter((_, i) => reply.includes(`[${i + 1}]`)).map((w) => ({ kind: "web" as const, title: w.title, url: w.url })),
        ...booksMentioned(reply, library).map((b) => ({ kind: "book" as const, title: b.title, bookId: b.id })),
      ];

  const t = now.getTime();
  const userMsg = insertMessage(db, { userId: reader.userId, conversationId: conversation.id, bookId, role: "user", content: text, moderation: userNote, provider: null, createdAt: t });
  const replyMsg = insertMessage(db, {
    userId: reader.userId,
    conversationId: conversation.id,
    bookId,
    role: "assistant",
    content: reply,
    moderation: replyNote,
    provider: `${config.id}:${result.model}`,
    createdAt: t + 1,
  });
  sources.forEach((s, position) =>
    db.insert(aiMessageSources).values({ messageId: replyMsg.id, position, kind: s.kind, title: s.title, url: s.url ?? null, bookId: s.bookId ?? null }).run(),
  );
  db.update(aiConversations)
    .set({ updatedAt: t, ...(replyNote ? { flagged: true } : {}) })
    .where(eq(aiConversations.id, conversation.id))
    .run();

  return {
    conversationId: conversation.id,
    message: view(userMsg, []),
    reply: view(replyMsg, sources),
    remainingToday: access ? access.remainingToday - 1 : null,
    searchError,
  };
}

function blocked(
  ctx: AiContext,
  reader: Reader,
  conversationId: string,
  bookId: string | null,
  text: string,
  verdict: ModerationResult,
  now: Date,
  access: KidAccess | null,
) {
  const { db } = ctx;
  const t = now.getTime();
  const category = verdict.category ?? "other";
  const userMsg = insertMessage(db, { userId: reader.userId, conversationId, bookId, role: "user", content: text, moderation: `blocked:${category}`, provider: null, createdAt: t });
  const content = reader.isKid ? kidSafeReply(category, "input") : "Sorry, I can't help with that one.";
  const replyMsg = insertMessage(db, { userId: reader.userId, conversationId, bookId, role: "assistant", content, moderation: "canned", provider: null, createdAt: t + 1 });
  db.update(aiConversations).set({ updatedAt: t, flagged: true }).where(eq(aiConversations.id, conversationId)).run();
  return {
    conversationId,
    message: view(userMsg, []),
    reply: view(replyMsg, []),
    remainingToday: access ? access.remainingToday - 1 : null,
    searchError: null,
  };
}

function insertMessage(db: Db, row: typeof aiMessages.$inferInsert) {
  return db.insert(aiMessages).values(row).returning().get();
}

function view(m: typeof aiMessages.$inferSelect, sources: SourceView[]): MessageView {
  return { id: m.id, role: m.role as "user" | "assistant", content: m.content, moderation: m.moderation, createdAt: m.createdAt, sources };
}

/** The last few turns, minus blocked messages and their canned answers. */
function recentHistory(db: Db, conversationId: string): ChatMessage[] {
  const rows = db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(HISTORY * 2)
    .all()
    .reverse();
  return rows
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.moderation?.startsWith("blocked") && m.moderation !== "canned")
    .slice(-HISTORY)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

/**
 * Messages of a conversation as `viewer` may see them. Book sources are re-checked against
 * the viewer's content lock, so a book that was re-rated since drops out of old chats.
 */
export function conversationMessages(db: Db, viewer: Reader, conversationId: string): MessageView[] {
  const rows = db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.createdAt)).all();
  if (!rows.length) return [];
  const srcRows = db
    .select()
    .from(aiMessageSources)
    .where(inArray(aiMessageSources.messageId, rows.map((r) => r.id)))
    .orderBy(asc(aiMessageSources.position))
    .all();
  const bookIds = [...new Set(srcRows.map((s) => s.bookId).filter((x): x is string => !!x))];
  const visible = new Set(
    bookIds.length
      ? db
          .select({ id: books.id })
          .from(books)
          .where(and(inArray(books.id, bookIds), visibleBooksWhere(viewer)))
          .all()
          .map((b) => b.id)
      : [],
  );
  const bySource = new Map<string, SourceView[]>();
  for (const s of srcRows) {
    if (s.kind === "book" && (!s.bookId || !visible.has(s.bookId))) continue;
    const list = bySource.get(s.messageId) ?? [];
    list.push({ kind: s.kind, title: s.title, url: s.url, bookId: s.bookId });
    bySource.set(s.messageId, list);
  }
  return rows.filter((m) => m.role !== "system").map((m) => view(m, bySource.get(m.id) ?? []));
}
