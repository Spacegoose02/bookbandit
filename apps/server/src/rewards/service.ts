/**
 * Goals, badges, stickers and bedtime. Everything is decided from what the server already
 * knows (capped reading-time heartbeats and finished-book progress), never from a client's claim.
 */
import { and, desc, eq, gte, isNull, inArray, sum } from "drizzle-orm";
import {
  addDays,
  BADGES,
  bedtimeStatus,
  DEFAULT_BEDTIME,
  localTime,
  longestRun,
  stickerEmoji,
  STICKER_REASON_LABELS,
  type BadgeId,
  type BedtimeSettings,
  type NewAward,
  type ReadingGoal,
  type RewardsSummary,
  type RewardSticker,
  type StickerReason,
} from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books, readingProgress, readingSessions } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { readingBedtimes, readingGoals, rewardAwards } from "./schema.js";

/** How far back daily totals are looked at for streaks and goal days. */
export const WINDOW_DAYS = 40;
/** Stickers returned to the sticker book. */
export const STICKER_PAGE = 120;

// ---------------------------------------------------------------- settings

export function getGoal(db: Db, kidId: string): (ReadingGoal & { startsOn: string }) | null {
  const row = db.select().from(readingGoals).where(eq(readingGoals.kidId, kidId)).get();
  if (!row || (row.minutesPerDay == null && row.booksPerMonth == null)) return null;
  return { minutesPerDay: row.minutesPerDay, booksPerMonth: row.booksPerMonth, timeZone: row.timeZone, startsOn: row.startsOn };
}

export function saveGoal(db: Db, kidId: string, goal: ReadingGoal, by: string, now = Date.now()): ReadingGoal | null {
  const existing = db.select().from(readingGoals).where(eq(readingGoals.kidId, kidId)).get();
  // A new or changed daily goal counts from today, so lowering it can't backfill stickers.
  const minutesChanged = !existing || existing.minutesPerDay !== goal.minutesPerDay;
  const startsOn = minutesChanged ? localTime(now, goal.timeZone).date : existing.startsOn;
  const values = { kidId, ...goal, startsOn, updatedBy: by, updatedAt: now };
  db.insert(readingGoals).values(values).onConflictDoUpdate({ target: readingGoals.kidId, set: values }).run();
  const saved = getGoal(db, kidId);
  return saved && { minutesPerDay: saved.minutesPerDay, booksPerMonth: saved.booksPerMonth, timeZone: saved.timeZone };
}

export function getBedtime(db: Db, kidId: string): BedtimeSettings {
  const row = db.select().from(readingBedtimes).where(eq(readingBedtimes.kidId, kidId)).get();
  if (!row) return { ...DEFAULT_BEDTIME };
  return {
    enabled: row.enabled,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    weekendStartMinute: row.weekendStartMinute,
    timeZone: row.timeZone,
  };
}

export function saveBedtime(db: Db, kidId: string, s: BedtimeSettings, by: string, now = Date.now()): BedtimeSettings {
  const values = { kidId, ...s, updatedBy: by, updatedAt: now };
  db.insert(readingBedtimes).values(values).onConflictDoUpdate({ target: readingBedtimes.kidId, set: values }).run();
  return getBedtime(db, kidId);
}

// ---------------------------------------------------------------- awarding

interface Award {
  kind: "badge" | "sticker";
  award: string;
  key: string;
  bookId?: string | null;
  emoji: string;
  earnedAt: number;
}

function give(db: Db, userId: string, a: Award): void {
  db.insert(rewardAwards)
    .values({ userId, kind: a.kind, award: a.award, key: a.key, bookId: a.bookId ?? null, emoji: a.emoji, earnedAt: a.earnedAt })
    .onConflictDoNothing()
    .run();
}

const BADGE_BY_ID = new Map<string, (typeof BADGES)[number]>(BADGES.map((b) => [b.id, b]));
const badge = (id: BadgeId, earnedAt: number): Award => ({ kind: "badge", award: id, key: "", emoji: BADGE_BY_ID.get(id)!.emoji, earnedAt });
const sticker = (reason: StickerReason, key: string, earnedAt: number, bookId?: string): Award => ({
  kind: "sticker",
  award: reason,
  key,
  bookId,
  emoji: stickerEmoji(reason, key),
  earnedAt,
});

/** Seconds read or listened per local date, over the last WINDOW_DAYS. */
function dailySeconds(db: Db, userId: string, timeZone: string, now: number): Map<string, number> {
  const rows = db
    .select({ startedAt: readingSessions.startedAt, seconds: readingSessions.seconds })
    .from(readingSessions)
    .where(and(eq(readingSessions.userId, userId), gte(readingSessions.startedAt, now - (WINDOW_DAYS + 1) * 86_400_000)))
    .all();
  const out = new Map<string, number>();
  for (const r of rows) {
    const d = localTime(r.startedAt, timeZone).date;
    out.set(d, (out.get(d) ?? 0) + r.seconds);
  }
  return out;
}

/** The time zone a kid's days are counted in: the goal's, else bedtime's, else UTC. */
function zoneFor(db: Db, userId: string): string {
  return getGoal(db, userId)?.timeZone ?? (getBedtime(db, userId).enabled ? getBedtime(db, userId).timeZone : "UTC");
}

/**
 * Look at reading time and finished books and award anything newly earned. Idempotent:
 * the unique (user, award, key) index means running it again adds nothing.
 */
export function evaluate(db: Db, userId: string, now = Date.now()) {
  const goal = getGoal(db, userId);
  const tz = zoneFor(db, userId);
  const today = localTime(now, tz);
  const daily = dailySeconds(db, userId, tz, now);
  const total =
    db
      .select({ s: sum(readingSessions.seconds).mapWith(Number) })
      .from(readingSessions)
      .where(eq(readingSessions.userId, userId))
      .get()?.s ?? 0;

  // Finished books: one sticker each, dated when the server first saw it finished.
  const finished = db
    .select({ bookId: readingProgress.bookId, at: readingProgress.serverUpdatedAt })
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.finished, true)))
    .all();
  for (const f of finished) give(db, userId, sticker("book", f.bookId, Math.min(f.at, now), f.bookId));
  const n = finished.length;
  if (n >= 1) give(db, userId, badge("first_book", now));
  if (n >= 5) give(db, userId, badge("books_5", now));
  if (n >= 10) give(db, userId, badge("books_10", now));
  if (n >= 25) give(db, userId, badge("books_25", now));

  // Streaks: consecutive days with any reading.
  const readDays = [...daily].filter(([, s]) => s > 0).map(([d]) => d);
  const run = longestRun(readDays);
  if (run >= 3) give(db, userId, badge("streak_3", now));
  if (run >= 7) give(db, userId, badge("streak_7", now));
  if (run >= 30) give(db, userId, badge("streak_30", now));
  if (total >= 3600) give(db, userId, badge("hour_1", now));
  if (total >= 36_000) give(db, userId, badge("hours_10", now));

  // Daily goal: a sticker for every day it was reached since the goal was set.
  const goalSeconds = goal?.minutesPerDay != null ? goal.minutesPerDay * 60 : null;
  if (goal && goalSeconds != null) {
    for (const [date, s] of daily) {
      if (date < goal.startsOn || date > today.date || s < goalSeconds) continue;
      give(db, userId, sticker("goal_day", date, now));
      give(db, userId, badge("goal_first", now));
    }
    const metDays = db
      .select({ key: rewardAwards.key })
      .from(rewardAwards)
      .where(and(eq(rewardAwards.userId, userId), eq(rewardAwards.award, "goal_day")))
      .all()
      .map((r) => r.key);
    if (longestRun(metDays) >= 7) give(db, userId, badge("goal_week", now));
  }

  // Monthly books goal: books whose sticker was earned this local month.
  const bookStickers = db
    .select({ earnedAt: rewardAwards.earnedAt })
    .from(rewardAwards)
    .where(and(eq(rewardAwards.userId, userId), eq(rewardAwards.award, "book"), gte(rewardAwards.earnedAt, now - 32 * 86_400_000)))
    .all();
  const booksThisMonth = bookStickers.filter((b) => localTime(b.earnedAt, tz).month === today.month).length;
  const goalBooks = goal?.booksPerMonth ?? null;
  if (goalBooks != null && booksThisMonth >= goalBooks) {
    give(db, userId, sticker("goal_month", today.month, now));
    give(db, userId, badge("goal_month", now));
  }

  // Current streak: today not read yet doesn't break it.
  const dayRead = new Set(readDays);
  let streak = 0;
  for (let d = dayRead.has(today.date) ? today.date : addDays(today.date, -1); dayRead.has(d); d = addDays(d, -1)) streak++;

  const readToday = daily.get(today.date) ?? 0;
  return {
    goal: goal && { minutesPerDay: goal.minutesPerDay, booksPerMonth: goal.booksPerMonth, timeZone: goal.timeZone },
    today: { date: today.date, readSeconds: readToday, goalSeconds, met: goalSeconds != null && readToday >= goalSeconds },
    month: { month: today.month, books: booksThisMonth, goalBooks, met: goalBooks != null && booksThisMonth >= goalBooks },
    streakDays: streak,
    totalSeconds: total,
    booksFinished: n,
  };
}

/**
 * The full summary for the kid home or a parent's card. Book stickers only name books both
 * the kid and the viewer may see (CLAUDE.md rule 1); others show as a plain sticker.
 */
export function summary(db: Db, subject: Reader, viewer: Reader, now = Date.now()): RewardsSummary {
  const stats = evaluate(db, subject.userId, now);
  const awards = db
    .select()
    .from(rewardAwards)
    .where(eq(rewardAwards.userId, subject.userId))
    .orderBy(desc(rewardAwards.earnedAt))
    .all();

  const bookIds = [...new Set(awards.filter((a) => a.bookId).map((a) => a.bookId!))];
  const visible = new Map(
    bookIds.length
      ? db
          .select({ id: books.id, title: books.title, coverPath: books.coverPath })
          .from(books)
          .where(and(inArray(books.id, bookIds), visibleBooksWhere(subject), visibleBooksWhere(viewer)))
          .all()
          .map((b) => [b.id, b])
      : [],
  );

  const earned = new Map(awards.filter((a) => a.kind === "badge").map((a) => [a.award, a.earnedAt]));
  const stickers: RewardSticker[] = awards
    .filter((a) => a.kind === "sticker")
    .slice(0, STICKER_PAGE)
    .map((a) => ({
      id: a.id,
      reason: a.award as StickerReason,
      emoji: a.emoji,
      earnedAt: a.earnedAt,
      key: a.bookId ? "" : a.key,
      book: a.bookId ? (visible.get(a.bookId) ?? null) : null,
    }));

  const fresh: NewAward[] =
    subject.userId === viewer.userId
      ? awards
          .filter((a) => a.seenAt == null)
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            emoji: a.emoji,
            name:
              a.kind === "badge"
                ? (BADGE_BY_ID.get(a.award)?.name ?? a.award)
                : a.bookId && visible.has(a.bookId)
                  ? `You finished ${visible.get(a.bookId)!.title}!`
                  : (STICKER_REASON_LABELS[a.award as StickerReason] ?? "New sticker"),
          }))
      : [];

  return {
    user: { id: subject.userId, displayName: subject.displayName },
    ...stats,
    badges: BADGES.map((b) => ({ ...b, earnedAt: earned.get(b.id) ?? null })),
    stickers,
    fresh,
    bedtime: bedtimeStatus(getBedtime(db, subject.userId), now),
  };
}

/** The kid saw the celebration for these awards. Only their own; unknown ids are ignored. */
export function markSeen(db: Db, userId: string, ids: string[], now = Date.now()): number {
  if (!ids.length) return 0;
  return db
    .update(rewardAwards)
    .set({ seenAt: now })
    .where(and(eq(rewardAwards.userId, userId), inArray(rewardAwards.id, ids), isNull(rewardAwards.seenAt)))
    .run().changes;
}
