/**
 * Barnaby's part in word help and quizzes. Uses the providers set up for Barnaby (docs/ai.md):
 * the kid chat provider for kids, chat for grown-ups, and the moderation model on every answer a
 * kid sees. Kids only get AI help when a parent has turned Barnaby on for them and they're 5 or
 * older; word help and quizzes have their own small daily cap so they never use up chat.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { AiContext } from "../ai/context.js";
import { kidAccess, kidSettings, startOfDay } from "../ai/kids.js";
import { moderate } from "../ai/moderation.js";
import { makeProvider, type AiProvider, type ChatResult } from "../ai/providers/index.js";
import { getAiSettings, providerFor } from "../ai/settings.js";
import { tracked } from "../ai/usage.js";
import type { Reader } from "../auth/reader.js";
import { learningLookups, learningQuizzes } from "./schema.js";

export const KID_AI_DAILY = 40;

export interface LearningAi {
  ask(system: string, user: string, maxTokens: number): Promise<string | null>;
  age: number | null;
}

/** Barnaby for this reader, or null when AI isn't available to them right now. */
export function learningAi(ctx: AiContext, reader: Reader, feature: "word" | "quiz"): LearningAi | null {
  const settings = getAiSettings(ctx.db, ctx.box);
  const kid = reader.role === "kid";
  const config = providerFor(settings, kid ? "kidChat" : "chat");
  if (!config) return null;
  let age: number | null = null;
  if (kid) {
    const access = kidAccess(ctx.db, reader, kidSettings(ctx.db, reader.userId, settings.kidDefaults), ctx.now());
    age = access.age;
    // Chat's own daily limit doesn't apply here; ours does.
    if (!access.allowed && access.reason !== "daily_limit") return null;
    if (aiUsedToday(ctx, reader.userId) >= KID_AI_DAILY) return null;
  }
  const provider = makeProvider(config, ctx.fetchImpl);
  const modConfig = providerFor(settings, "moderation");
  const modProvider = modConfig ? makeProvider(modConfig, ctx.fetchImpl) : null;
  const call = (p: AiProvider, f: string, run: () => Promise<ChatResult>) => tracked(ctx, p, f, reader.userId, run);
  const label = feature === "word" ? "wordHelp" : "quiz";
  return {
    age,
    async ask(system, user, maxTokens) {
      try {
        const r = await call(provider, label, () => provider.chat({ system, messages: [{ role: "user", content: user }], maxTokens, json: true }));
        if (kid || settings.moderation.adults) {
          const verdict = await moderate(r.text, { kid, age, direction: "output", provider: modProvider, useWords: kid }, (p, run) => call(p, "moderation", run));
          if (verdict.flagged) return null;
        }
        return r.text;
      } catch {
        return null;
      }
    },
  };
}

export function aiUsedToday(ctx: AiContext, userId: string): number {
  const since = startOfDay(ctx.now());
  const words =
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(learningLookups)
      .where(and(eq(learningLookups.userId, userId), eq(learningLookups.source, "ai"), gte(learningLookups.createdAt, since)))
      .get()?.n ?? 0;
  const quizzes =
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(learningQuizzes)
      .where(and(eq(learningQuizzes.userId, userId), eq(learningQuizzes.source, "ai"), gte(learningQuizzes.createdAt, since)))
      .get()?.n ?? 0;
  return words + quizzes;
}

export function wordPrompt(age: number | null): string {
  const who = age != null ? `a ${age}-year-old` : "a reader";
  return [
    `You are Barnaby, a friendly raccoon who helps ${who} with words in the book they're reading.`,
    "Explain what the word means in the sentence given, in one or two short, simple sentences. Then give one short example sentence.",
    "If the word is rude, scary or not suitable for a child, reply with an empty meaning.",
    'Reply with JSON only: {"meaning":"...","example":"..."}',
  ].join("\n");
}

export function parseWordReply(text: string): { meaning: string; example: string | null } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]) as { meaning?: unknown; example?: unknown };
    if (typeof raw.meaning !== "string" || !raw.meaning.trim()) return null;
    return { meaning: raw.meaning.trim().slice(0, 400), example: typeof raw.example === "string" && raw.example.trim() ? raw.example.trim().slice(0, 300) : null };
  } catch {
    return null;
  }
}
