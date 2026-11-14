/**
 * Reading time → Den Duty practice.
 *
 * Every few minutes, for each household with a Den Duty link, sends each linked kid's reading and
 * listening minutes for today (and yesterday, so the last minutes before midnight still count) to
 * Den Duty's `POST /api/v1/homes/:homeId/reading/report`, plus the books they finished that day.
 * Den Duty logs the minutes into the kid's practice habit and pays its points; repeated reports
 * carry the day's running total, so Den Duty never double counts. Finished books pay Den Duty's
 * "finished a book" bonus once per book id.
 *
 * Only minutes and finished books leave BookBandit. Finished books go through the content lock for
 * that kid, so a book the kid can't see is never named.
 */
import { and, eq, gte, inArray, lt, sum } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books, readingProgress, readingSessions, users } from "../db/schema.js";
import { toReader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import type { DenDutyLink } from "./settings.js";

export interface DenHome {
  id: string;
  name: string;
  timezone: string;
  /** Today's date in the home's time zone, YYYY-MM-DD. */
  today: string;
}

export interface DenKid {
  id: string;
  name: string;
  avatar?: string;
  color?: string;
}

export interface DenHabit {
  id: string;
  title: string;
  icon: string;
  minutes: number | null;
}

export interface ReportKid {
  kidId: string;
  habitId: string;
  date: string;
  minutes: number;
  finished: { id: string; title: string }[];
}

export interface ReportResult {
  ok: boolean;
  kids?: { kidId: string; minutes: number; habitPaid: number; finishedPaid: number }[];
}

/** Milliseconds to add to UTC to get local time in `tz` at instant `t`. */
export function tzOffsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant local midnight starts `date` (YYYY-MM-DD) in `tz`. Unknown zones count as UTC. */
export function startOfDay(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  let off: number;
  try {
    off = tzOffsetMs(utcMidnight, tz);
  } catch {
    return utcMidnight;
  }
  // Second pass covers a DST change between UTC midnight and local midnight.
  const guess = utcMidnight - off;
  return utcMidnight - tzOffsetMs(guess, tz);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** What one kid did on one Den Duty day: minutes read or listened, and books finished. */
export function kidDay(db: Db, userId: string, date: string, tz: string): { minutes: number; finished: { id: string; title: string }[] } {
  const from = startOfDay(date, tz);
  const to = startOfDay(addDays(date, 1), tz);
  const secs =
    db
      .select({ s: sum(readingSessions.seconds).mapWith(Number) })
      .from(readingSessions)
      .where(and(eq(readingSessions.userId, userId), gte(readingSessions.startedAt, from), lt(readingSessions.startedAt, to)))
      .get()?.s ?? 0;

  const u = db.select().from(users).where(eq(users.id, userId)).get();
  const finished = u
    ? db
        .select({ id: books.id, title: books.title })
        .from(readingProgress)
        .innerJoin(books, eq(books.id, readingProgress.bookId))
        .where(
          and(
            eq(readingProgress.userId, userId),
            eq(readingProgress.finished, true),
            gte(readingProgress.serverUpdatedAt, from),
            lt(readingProgress.serverUpdatedAt, to),
            visibleBooksWhere(toReader(u)),
          ),
        )
        .limit(20)
        .all()
    : [];
  return { minutes: Math.floor(secs / 60), finished };
}

/** The report for a household: every linked kid who still lives here, for yesterday and today. */
export function buildReport(db: Db, householdId: string, link: DenDutyLink, home: DenHome): ReportKid[] {
  const userIds = Object.keys(link.kids);
  if (!userIds.length) return [];
  const kids = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.householdId, householdId), eq(users.role, "kid"), eq(users.disabled, false)))
    .all();
  const out: ReportKid[] = [];
  for (const date of [addDays(home.today, -1), home.today]) {
    for (const k of kids) {
      const map = link.kids[k.id]!;
      const day = kidDay(db, k.id, date, home.timezone);
      out.push({ kidId: map.kidId, habitId: map.habitId, date, minutes: Math.min(day.minutes, 1440), finished: day.finished });
    }
  }
  return out;
}
