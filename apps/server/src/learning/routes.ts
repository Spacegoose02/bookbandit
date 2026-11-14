/**
 * Word help and after-chapter quizzes. See README.md in this folder.
 *
 * Content lock (CLAUDE.md rule 1): a word lookup with a book, a quiz and the parent summary all
 * check the book as the person asking; locked books 404. Parents (and admins) see their kids'
 * quizzes and looked-up words; kids can't change anything a parent set (rule 2).
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { canManageKids } from "@bookbandit/shared";
import type { AiContext } from "../ai/context.js";
import { httpError, requireReader } from "../auth/plugin.js";
import { loadVisibleUser } from "../auth/permissions.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee, visibleBooksWhere } from "../content/lock.js";
import { bookFiles, books } from "../db/schema.js";
import { learningAi, parseWordReply, wordPrompt } from "./ai.js";
import { sectionText } from "./chapter.js";
import { baseForms, loadDictionaryFile, lookupOffline, normalizeWord, syllables } from "./dictionary.js";
import { cheer, finalCheer, offlineQuiz, parseQuiz, quizPrompt } from "./quiz.js";
import { learningLookups, learningQuizzes, learningWords, type QuizQuestion } from "./schema.js";

export interface LearningContext extends AiContext {
  configDir: string;
}

const DAY = 86_400_000;
const WordParams = z.object({ word: z.string().min(1).max(60) });
const WordQuery = z.object({ bookId: z.string().min(1).max(64).optional(), context: z.string().max(400).optional() });
const WordBody = z.object({ meaning: z.string().trim().min(1).max(400), example: z.string().trim().max(300).nullable().optional() });
const QuizBody = z.object({ bookId: z.string().min(1).max(64), section: z.string().min(1).max(500), chapterLabel: z.string().max(200).nullable().optional() });
const QuizParams = z.object({ id: z.string().min(1).max(64) });
const AnswerBody = z.object({ question: z.number().int().min(0).max(9), choice: z.number().int().min(0).max(9) });
const KidParams = z.object({ kidId: z.string().min(1).max(64) });
const SummaryQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

type QuizRow = typeof learningQuizzes.$inferSelect;

/** What the reader sees: the right answer only after they've picked. */
export function quizView(q: QuizRow, bookTitle?: string | null) {
  return {
    id: q.id,
    bookId: q.bookId,
    bookTitle: bookTitle ?? undefined,
    chapterLabel: q.chapterLabel,
    source: q.source,
    createdAt: q.createdAt,
    completedAt: q.completedAt,
    score: q.score,
    questions: q.questions.map((x) => ({ q: x.q, choices: x.choices, picked: x.picked ?? null, answer: x.picked != null ? x.answer : null })),
  };
}

export async function learningRoutes(app: FastifyInstance, ctx: LearningContext) {
  const { db } = ctx;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Bad request", message: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  function visibleBook(reader: Reader, bookId: string) {
    const book = db.select({ id: books.id, title: books.title, rating: books.rating, approved: books.approved }).from(books).where(eq(books.id, bookId)).get();
    if (!book) throw httpError(404, "Not found");
    assertCanSee(reader, book, ctx.now());
    return book;
  }

  // --- word help -------------------------------------------------------------
  app.get("/api/learning/words/:word", async (req) => {
    const reader = requireReader(req);
    const raw = WordParams.parse(req.params).word;
    const { bookId, context } = WordQuery.parse(req.query);
    if (bookId) visibleBook(reader, bookId);
    const word = normalizeWord(raw);
    if (!word) throw httpError(400, "That doesn't look like a word");
    const now = ctx.now().getTime();
    const log = (source: "dictionary" | "family" | "ai" | "none") =>
      db.insert(learningLookups).values({ userId: reader.userId, bookId: bookId ?? null, word, source, createdAt: now }).run();
    const answer = (headword: string, meaning: string | null, example: string | null, source: "dictionary" | "family" | "ai" | "none") => ({
      word,
      headword,
      syllables: syllables(word),
      meaning,
      example,
      source,
    });

    // 1. The family's own meanings (and Barnaby's earlier answers).
    const forms = baseForms(word);
    const family = db
      .select()
      .from(learningWords)
      .where(and(eq(learningWords.householdId, reader.householdId), inArray(learningWords.word, forms)))
      .all()
      .sort((a, b) => forms.indexOf(a.word) - forms.indexOf(b.word))[0];
    if (family) {
      log("family");
      return answer(family.word, family.meaning, family.example, family.source === "ai" ? "ai" : "family");
    }

    // 2. Offline dictionary.
    const hit = lookupOffline(word, await loadDictionaryFile(ctx.configDir));
    if (hit) {
      log("dictionary");
      return answer(hit.headword, hit.entry.meaning, hit.entry.example ?? null, "dictionary");
    }

    // 3. Barnaby, if he's allowed to help this reader.
    const ai = learningAi(ctx, reader, "word");
    if (ai) {
      const reply = await ai.ask(wordPrompt(ai.age), `Word: ${word}\nSentence: ${(context ?? "").slice(0, 400) || "(none)"}`, 200);
      const parsed = reply ? parseWordReply(reply) : null;
      if (parsed) {
        db.insert(learningWords)
          .values({ householdId: reader.householdId, word, meaning: parsed.meaning, example: parsed.example, source: "ai", updatedBy: null, updatedAt: now })
          .onConflictDoNothing()
          .run();
        log("ai");
        return answer(word, parsed.meaning, parsed.example, "ai");
      }
    }
    log("none");
    return answer(word, null, null, "none");
  });

  function requireGrownUp(req: Parameters<typeof requireReader>[0]): Reader {
    const reader = requireReader(req);
    if (!canManageKids(reader.role)) throw httpError(403, "Only a parent or admin can change word meanings");
    return reader;
  }

  /** The family's word list: parents check Barnaby's meanings and add their own. */
  app.get("/api/learning/words", async (req) => {
    const reader = requireGrownUp(req);
    return db.select().from(learningWords).where(eq(learningWords.householdId, reader.householdId)).orderBy(learningWords.word).all();
  });

  app.put("/api/learning/words/:word", async (req) => {
    const reader = requireGrownUp(req);
    const word = normalizeWord(WordParams.parse(req.params).word);
    if (!word) throw httpError(400, "That doesn't look like a word");
    const body = WordBody.parse(req.body);
    const values = { householdId: reader.householdId, word, meaning: body.meaning, example: body.example ?? null, source: "family" as const, updatedBy: reader.userId, updatedAt: ctx.now().getTime() };
    db.insert(learningWords)
      .values(values)
      .onConflictDoUpdate({ target: [learningWords.householdId, learningWords.word], set: values })
      .run();
    return db.select().from(learningWords).where(and(eq(learningWords.householdId, reader.householdId), eq(learningWords.word, word))).get();
  });

  app.delete("/api/learning/words/:word", async (req, reply) => {
    const reader = requireGrownUp(req);
    const word = normalizeWord(WordParams.parse(req.params).word);
    if (word) db.delete(learningWords).where(and(eq(learningWords.householdId, reader.householdId), eq(learningWords.word, word))).run();
    return reply.code(204).send();
  });

  // --- quizzes ---------------------------------------------------------------
  /** Make (or re-open today's) quiz for the chapter the reader just finished. */
  app.post("/api/learning/quizzes", async (req, reply) => {
    const reader = requireReader(req);
    const body = QuizBody.parse(req.body);
    const book = visibleBook(reader, body.bookId);
    const now = ctx.now().getTime();
    const existing = db
      .select()
      .from(learningQuizzes)
      .where(and(eq(learningQuizzes.userId, reader.userId), eq(learningQuizzes.bookId, book.id), eq(learningQuizzes.section, body.section), gte(learningQuizzes.createdAt, now - DAY)))
      .orderBy(desc(learningQuizzes.createdAt))
      .get();
    if (existing) return quizView(existing, book.title);

    const file = db
      .select({ relPath: bookFiles.relPath, format: bookFiles.format })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, book.id))
      .all()
      .find((f) => f.format === "epub" || f.format === "kepub");
    if (!file) return reply.code(422).send({ error: "no_text", message: "Quizzes work on EPUB books" });
    const text = await sectionText(ctx.booksDir, file.relPath, body.section).catch(() => null);
    if (text == null) throw httpError(404, "Not found");
    if (text.length < 300) return reply.code(422).send({ error: "too_short", message: "This part is too short for a quiz" });

    const id = crypto.randomUUID();
    let questions: QuizQuestion[] | null = null;
    let source: "ai" | "offline" = "offline";
    const ai = learningAi(ctx, reader, "quiz");
    if (ai) {
      const r = await ai.ask(quizPrompt(ai.age), `Chapter text:\n${text.slice(0, 12_000)}`, 700);
      questions = r ? parseQuiz(r) : null;
      if (questions) source = "ai";
    }
    questions ??= offlineQuiz(text, id);
    if (!questions) return reply.code(422).send({ error: "too_short", message: "This part is too short for a quiz" });
    const row = db
      .insert(learningQuizzes)
      .values({ id, userId: reader.userId, bookId: book.id, section: body.section, chapterLabel: body.chapterLabel ?? null, questions, source, createdAt: now })
      .returning()
      .get();
    return quizView(row, book.title);
  });

  /** One answer at a time, so Barnaby can cheer right away. The first pick is the one that counts. */
  app.post("/api/learning/quizzes/:id/answer", async (req) => {
    const reader = requireReader(req);
    const { id } = QuizParams.parse(req.params);
    const body = AnswerBody.parse(req.body);
    const quiz = db.select().from(learningQuizzes).where(and(eq(learningQuizzes.id, id), eq(learningQuizzes.userId, reader.userId))).get();
    if (!quiz) throw httpError(404, "Not found");
    visibleBook(reader, quiz.bookId);
    const q = quiz.questions[body.question];
    if (!q || body.choice >= q.choices.length) throw httpError(400, "No such answer");
    const questions = quiz.questions.map((x, i) => (i === body.question && x.picked == null ? { ...x, picked: body.choice } : x));
    const picked = questions[body.question]!.picked!;
    const done = questions.every((x) => x.picked != null);
    const score = questions.filter((x) => x.picked === x.answer).length;
    const completedAt = done ? (quiz.completedAt ?? ctx.now().getTime()) : null;
    db.update(learningQuizzes)
      .set({ questions, completedAt, score: done ? score : null })
      .where(eq(learningQuizzes.id, id))
      .run();
    const correct = picked === q.answer;
    return {
      correct,
      answer: q.answer,
      cheer: cheer(correct, q.choices[q.answer]!),
      done,
      score: done ? score : null,
      finalCheer: done ? finalCheer(score, questions.length) : null,
    };
  });

  // --- parents ---------------------------------------------------------------
  /** A kid's quizzes and looked-up words, for the family dashboard. Linked parents and admins. */
  app.get("/api/learning/kids/:kidId", async (req) => {
    const viewer = requireReader(req);
    const { kidId } = KidParams.parse(req.params);
    const { days } = SummaryQuery.parse(req.query);
    const kid = loadVisibleUser(db, viewer, kidId === "me" ? viewer.userId : kidId);
    if (kid.role !== "kid") throw httpError(404, "Not found");
    if (kid.id !== viewer.userId && !canManageKids(viewer.role)) throw httpError(404, "Not found");
    const since = ctx.now().getTime() - days * DAY;

    const quizzes = db
      .select({ q: learningQuizzes, title: books.title })
      .from(learningQuizzes)
      .innerJoin(books, eq(books.id, learningQuizzes.bookId))
      .where(and(eq(learningQuizzes.userId, kid.id), gte(learningQuizzes.createdAt, since), visibleBooksWhere(viewer)))
      .orderBy(desc(learningQuizzes.createdAt))
      .limit(30)
      .all()
      .map((r) => quizView(r.q, r.title));

    const lookups = db
      .select()
      .from(learningLookups)
      .where(and(eq(learningLookups.userId, kid.id), gte(learningLookups.createdAt, since)))
      .orderBy(desc(learningLookups.createdAt))
      .limit(200)
      .all();
    const bookIds = [...new Set(lookups.map((l) => l.bookId).filter((b): b is string => !!b))];
    const titles = new Map(
      bookIds.length
        ? db
            .select({ id: books.id, title: books.title })
            .from(books)
            .where(and(inArray(books.id, bookIds), visibleBooksWhere(viewer)))
            .all()
            .map((b) => [b.id, b.title])
        : [],
    );
    const words = new Map<string, { word: string; times: number; lastAt: number; bookTitle: string | null; found: boolean }>();
    for (const l of lookups) {
      const w = words.get(l.word);
      if (w) w.times++;
      else words.set(l.word, { word: l.word, times: 1, lastAt: l.createdAt, bookTitle: (l.bookId && titles.get(l.bookId)) || null, found: l.source !== "none" });
    }
    const done = quizzes.filter((q) => q.completedAt != null);
    return {
      kidId: kid.id,
      days,
      stats: {
        quizzes: done.length,
        correct: done.reduce((a, q) => a + (q.score ?? 0), 0),
        questions: done.reduce((a, q) => a + q.questions.length, 0),
        words: words.size,
      },
      quizzes,
      words: [...words.values()].slice(0, 60),
    };
  });
}
