/**
 * Kids' reading goals, Barnaby badges, stickers and reading bedtime: the rules both the server
 * (which decides and enforces) and the web app (which shows them) need.
 */
import { isValidTimeZone } from "./storyteller.js";

// ---------------------------------------------------------------------------
// Badges and stickers
// ---------------------------------------------------------------------------

export interface BadgeDef {
  id: string;
  emoji: string;
  name: string;
  /** How to earn it, short enough for a 7 year old to have read to them. */
  hint: string;
}

/** One-time badges, in the order the badge shelf shows them. */
export const BADGES = [
  { id: "first_book", emoji: "📕", name: "First book!", hint: "Finish a book" },
  { id: "books_5", emoji: "🐛", name: "Bookworm", hint: "Finish 5 books" },
  { id: "books_10", emoji: "🦝", name: "Book Bandit", hint: "Finish 10 books" },
  { id: "books_25", emoji: "🏰", name: "Library Legend", hint: "Finish 25 books" },
  { id: "streak_3", emoji: "🔥", name: "On a roll", hint: "Read 3 days in a row" },
  { id: "streak_7", emoji: "🌈", name: "Rainbow week", hint: "Read 7 days in a row" },
  { id: "streak_30", emoji: "🚀", name: "Rocket reader", hint: "Read 30 days in a row" },
  { id: "hour_1", emoji: "⏰", name: "First hour", hint: "Read for 1 hour in all" },
  { id: "hours_10", emoji: "🏆", name: "Ten hours", hint: "Read for 10 hours in all" },
  { id: "goal_first", emoji: "🎯", name: "Bullseye", hint: "Reach your reading goal for a day" },
  { id: "goal_week", emoji: "⭐", name: "Super star week", hint: "Reach your goal 7 days in a row" },
  { id: "goal_month", emoji: "🌙", name: "Moon month", hint: "Finish your books for the month" },
] as const satisfies readonly BadgeDef[];

export type BadgeId = (typeof BADGES)[number]["id"];

/** Repeatable stickers for the sticker book. */
export const STICKER_REASONS = ["book", "goal_day", "goal_month"] as const;
export type StickerReason = (typeof STICKER_REASONS)[number];

export const STICKER_REASON_LABELS: Record<StickerReason, string> = {
  book: "Finished a book",
  goal_day: "Reading goal reached",
  goal_month: "Monthly books goal",
};

const STICKER_EMOJI = ["🦖", "🦄", "🐙", "🌟", "🐸", "🚀", "🎈", "🍩", "🐢", "🦊", "🐝", "🌻", "🐳", "🍓", "🦋", "🐼"];

/** The same sticker every time for the same reason and key, so it doesn't change on reload. */
export function stickerEmoji(reason: string, key: string): string {
  let h = 2166136261;
  for (const ch of `${reason}:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return STICKER_EMOJI[(h >>> 0) % STICKER_EMOJI.length]!;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** A parent's reading goal for one kid. Either part may be off (null). */
export interface ReadingGoal {
  minutesPerDay: number | null;
  booksPerMonth: number | null;
  timeZone: string;
}

export const GOAL_LIMITS = {
  minutesPerDay: { min: 5, max: 240 },
  booksPerMonth: { min: 1, max: 60 },
} as const;

// ---------------------------------------------------------------------------
// Bedtime
// ---------------------------------------------------------------------------

/** Minutes after local midnight, 0..1439. */
export type MinuteOfDay = number;

export interface BedtimeSettings {
  enabled: boolean;
  /** Reading stops at this local time (school nights). */
  startMinute: MinuteOfDay;
  /** And starts again at this local time the next morning. */
  endMinute: MinuteOfDay;
  /** Later bedtime on Friday and Saturday nights; null = same as school nights. */
  weekendStartMinute: MinuteOfDay | null;
  timeZone: string;
}

export const DEFAULT_BEDTIME: BedtimeSettings = {
  enabled: false,
  startMinute: 20 * 60,
  endMinute: 7 * 60,
  weekendStartMinute: null,
  timeZone: "UTC",
};

export interface BedtimeStatus {
  enabled: boolean;
  /** It's bedtime right now: reading is paused until `endsAt`. */
  active: boolean;
  /** When reading opens again (ms), if active. */
  endsAt: number | null;
  /** Minutes until tonight's bedtime, when it's less than an hour away. */
  startsInMinutes: number | null;
}

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM */
  month: string;
  minute: MinuteOfDay;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock date and time at `at` in a time zone (UTC when the zone is unknown). */
export function localTime(at: number | Date, timeZone: string): LocalTime {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(typeof at === "number" ? new Date(at) : at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    date: `${y}-${m}-${d}`,
    month: `${y}-${m}`,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
    weekday,
  };
}

/** The YYYY-MM-DD date `days` before `date` (calendar math, no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

function isWeekendNight(weekday: number): boolean {
  return weekday === 5 || weekday === 6; // Friday and Saturday nights
}

/**
 * Is it bedtime now? Bedtime runs from the night's start time to the morning's end time.
 * A window that doesn't cross midnight (start before end) is treated as a plain daytime window.
 */
export function bedtimeStatus(s: BedtimeSettings, now: number): BedtimeStatus {
  const off: BedtimeStatus = { enabled: s.enabled, active: false, endsAt: null, startsInMinutes: null };
  if (!s.enabled) return off;
  const t = localTime(now, s.timeZone);
  const startTonight = isWeekendNight(t.weekday) && s.weekendStartMinute != null ? s.weekendStartMinute : s.startMinute;
  const end = s.endMinute;
  const minutesUntil = (target: number) => (((target - t.minute) % 1440) + 1440) % 1440;

  let active: boolean;
  if (startTonight > end) {
    // Crosses midnight: evening part tonight, or the morning part of last night.
    active = t.minute >= startTonight || t.minute < end;
  } else if (startTonight < end) {
    active = t.minute >= startTonight && t.minute < end;
  } else {
    active = false; // start == end: no bedtime
  }
  if (active) return { ...off, active: true, endsAt: (Math.floor(now / 60_000) + minutesUntil(end)) * 60_000 };
  const until = minutesUntil(startTonight);
  return { ...off, startsInMinutes: until > 0 && until <= 60 ? until : null };
}

/** "8:30 pm" style label for a minute of the day. */
export function formatMinute(m: MinuteOfDay): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

// ---------------------------------------------------------------------------
// What the kid home and the parent card get
// ---------------------------------------------------------------------------

export interface RewardBadge extends BadgeDef {
  earnedAt: number | null;
}

export interface RewardSticker {
  id: string;
  reason: StickerReason;
  emoji: string;
  earnedAt: number;
  /** For "book" stickers, when the viewer may see the book. */
  book: { id: string; title: string; coverPath: string | null } | null;
  /** YYYY-MM-DD or YYYY-MM for goal stickers. */
  key: string;
}

export interface NewAward {
  id: string;
  kind: "badge" | "sticker";
  emoji: string;
  name: string;
}

export interface RewardsSummary {
  user: { id: string; displayName: string };
  goal: ReadingGoal | null;
  today: { date: string; readSeconds: number; goalSeconds: number | null; met: boolean };
  month: { month: string; books: number; goalBooks: number | null; met: boolean };
  streakDays: number;
  totalSeconds: number;
  booksFinished: number;
  badges: RewardBadge[];
  stickers: RewardSticker[];
  /** Earned but not celebrated yet (only filled for the kid themselves). */
  fresh: NewAward[];
  bedtime: BedtimeStatus;
}

/** The longest run of consecutive dates in a set of YYYY-MM-DD strings. */
export function longestRun(dates: Iterable<string>): number {
  const set = new Set(dates);
  let best = 0;
  for (const d of set) {
    if (set.has(addDays(d, -1))) continue; // not the start of a run
    let n = 1;
    while (set.has(addDays(d, n))) n++;
    best = Math.max(best, n);
  }
  return best;
}
