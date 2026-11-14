/**
 * Kid AI rules: a parent turns Barnaby on per kid, no chat under 5, a daily message limit,
 * and web search only when the parent allows it.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { ageFromBirthYear } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { aiMessages } from "../db/schema.js";
import { aiKidSettings } from "./schema.js";

export const KID_MIN_AGE = 5;

export interface KidAiSettings {
  enabled: boolean;
  webSearch: boolean;
  dailyLimit: number;
  updatedAt: number | null;
}

export function kidSettings(db: Db, kidId: string, defaults: { dailyLimit: number }): KidAiSettings {
  const row = db.select().from(aiKidSettings).where(eq(aiKidSettings.kidId, kidId)).get();
  if (!row) return { enabled: false, webSearch: false, dailyLimit: defaults.dailyLimit, updatedAt: null };
  return { enabled: row.enabled, webSearch: row.webSearch, dailyLimit: row.dailyLimit, updatedAt: row.updatedAt };
}

export function saveKidSettings(db: Db, kidId: string, by: string, s: Omit<KidAiSettings, "updatedAt">, now: number) {
  const values = { kidId, enabled: s.enabled, webSearch: s.webSearch, dailyLimit: s.dailyLimit, setBy: by, updatedAt: now };
  db.insert(aiKidSettings)
    .values(values)
    .onConflictDoUpdate({ target: aiKidSettings.kidId, set: values })
    .run();
}

/** Midnight in the server's time zone (set TZ in Docker to the family's zone). */
export function startOfDay(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sentToday(db: Db, userId: string, now: Date): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(aiMessages)
      .where(and(eq(aiMessages.userId, userId), eq(aiMessages.role, "user"), gte(aiMessages.createdAt, startOfDay(now))))
      .get()?.n ?? 0
  );
}

export type KidBlock = "off" | "too_young" | "no_birth_year" | "daily_limit";

export interface KidAccess {
  allowed: boolean;
  reason?: KidBlock;
  age: number | null;
  remainingToday: number;
  webSearch: boolean;
}

export function kidAccess(db: Db, kid: { userId: string; birthYear: number | null }, s: KidAiSettings, now: Date): KidAccess {
  const age = kid.birthYear == null ? null : ageFromBirthYear(kid.birthYear, now);
  const remainingToday = Math.max(0, s.dailyLimit - sentToday(db, kid.userId, now));
  const base = { age, remainingToday, webSearch: s.webSearch };
  if (age == null) return { ...base, allowed: false, reason: "no_birth_year" };
  if (age < KID_MIN_AGE) return { ...base, allowed: false, reason: "too_young" };
  if (!s.enabled) return { ...base, allowed: false, reason: "off" };
  if (remainingToday <= 0) return { ...base, allowed: false, reason: "daily_limit" };
  return { ...base, allowed: true };
}

export const KID_BLOCK_MESSAGES: Record<KidBlock, string> = {
  off: "Barnaby's chat isn't turned on for you yet. Ask a grown-up to switch it on!",
  too_young: "Barnaby's chat is for readers who are 5 and up. Let's read a story together instead!",
  no_birth_year: "Ask a grown-up to add your birthday year first, then Barnaby can chat.",
  daily_limit: "That's all of Barnaby's chats for today! Come back tomorrow, or read a book now. 📚",
};
