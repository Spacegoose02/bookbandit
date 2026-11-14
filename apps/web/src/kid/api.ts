/**
 * Rewards API (apps/server/src/rewards/README.md): goals, badges, stickers and reading bedtime.
 * The server decides and enforces all of it; the demo version fakes a week of reading so the
 * screens can be tried and screenshotted without a server.
 */
import {
  BADGES,
  bedtimeStatus,
  DEFAULT_BEDTIME,
  localTime,
  stickerEmoji,
  type BedtimeSettings,
  type BedtimeStatus,
  type NewAward,
  type ReadingGoal,
  type RewardsSummary,
  type RewardSticker,
} from "@bookbandit/shared";
import { isDemo, request } from "../api/client";

export interface KidRewardSettings {
  kid: { id: string; displayName: string };
  canEdit: boolean;
  goal: ReadingGoal | null;
  bedtime: BedtimeSettings;
  bedtimeNow: BedtimeStatus;
}

export interface RewardsApi {
  /** "me" or a kid's id (linked parent or admin). */
  summary(userId: string): Promise<RewardsSummary>;
  markSeen(ids: string[]): Promise<void>;
  bedtime(): Promise<BedtimeStatus>;
  settings(kidId: string): Promise<KidRewardSettings>;
  saveGoal(kidId: string, goal: ReadingGoal): Promise<ReadingGoal | null>;
  saveBedtime(kidId: string, bedtime: BedtimeSettings): Promise<{ bedtime: BedtimeSettings; bedtimeNow: BedtimeStatus }>;
}

const enc = encodeURIComponent;
const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

export const httpRewardsApi: RewardsApi = {
  summary: (userId) => request(`/api/rewards/${enc(userId)}`),
  markSeen: async (ids) => {
    await request("/api/rewards/me/seen", { method: "POST", body: JSON.stringify({ ids }) });
  },
  bedtime: () => request("/api/rewards/me/bedtime"),
  settings: (kidId) => request(`/api/rewards/kids/${enc(kidId)}/settings`),
  saveGoal: (kidId, goal) => request<{ goal: ReadingGoal | null }>(`/api/rewards/kids/${enc(kidId)}/goal`, put(goal)).then((r) => r.goal),
  saveBedtime: (kidId, bedtime) => request(`/api/rewards/kids/${enc(kidId)}/bedtime`, put(bedtime)),
};

/** The browser's time zone, sent when a parent saves goals or bedtime. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// --------------------------------------------------------------------------- demo

const DEMO_GOAL = "bb-demo-rewards-goal";
const DEMO_BEDTIME = "bb-demo-rewards-bedtime";
const DEMO_SEEN = "bb-demo-rewards-seen";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** `?bedtime` in a demo URL shows the bedtime screen right away. */
function demoBedtimeForced(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("bedtime");
  } catch {
    return false;
  }
}

function demoBedtimeNow(): BedtimeStatus {
  if (demoBedtimeForced()) {
    const t = new Date();
    t.setHours(7, 0, 0, 0);
    if (t.getTime() < Date.now()) t.setDate(t.getDate() + 1);
    return { enabled: true, active: true, endsAt: t.getTime(), startsInMinutes: null };
  }
  return bedtimeStatus(load(DEMO_BEDTIME, { ...DEFAULT_BEDTIME, timeZone: browserTimeZone() }), Date.now());
}

const DAY = 86_400_000;
const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));

function demoSummary(): RewardsSummary {
  const now = Date.now();
  const tz = browserTimeZone();
  const goal = load<ReadingGoal | null>(DEMO_GOAL, { minutesPerDay: 20, booksPerMonth: 4, timeZone: tz });
  const seen = new Set(load<string[]>(DEMO_SEEN, []));
  const earned: Record<string, number> = {
    first_book: now - 20 * DAY,
    streak_3: now - 6 * DAY,
    hour_1: now - 9 * DAY,
    goal_first: now - 3 * DAY,
    books_5: now - 1 * DAY,
    streak_7: now - 2 * 3600_000,
  };
  const books: [string, string][] = [
    ["b1", "The Dinosaur Who Loved Books"],
    ["b2", "Dino Goes to School"],
    ["b3", "Barnaby and the Missing Page"],
    ["b15", "Little Fox Says Goodnight"],
    ["b16", "Moon and the Sleepy Sea"],
  ];
  const stickers: RewardSticker[] = [
    ...books.map(([id, title], i) => ({
      id: `s-book-${id}`,
      reason: "book" as const,
      emoji: stickerEmoji("book", id),
      earnedAt: now - (i * 4 + 1) * DAY,
      key: "",
      book: { id, title, coverPath: null },
    })),
    ...[1, 2, 3, 5, 6, 7].map((d) => {
      const key = localTime(now - d * DAY, tz).date;
      return { id: `s-goal-${key}`, reason: "goal_day" as const, emoji: stickerEmoji("goal_day", key), earnedAt: now - d * DAY, key, book: null };
    }),
  ].sort((a, b) => b.earnedAt - a.earnedAt);
  const fresh: NewAward[] = seen.has("demo-streak_7") ? [] : [{ id: "demo-streak_7", kind: "badge", emoji: "🌈", name: "Rainbow week" }];
  const goalSeconds = goal?.minutesPerDay != null ? goal.minutesPerDay * 60 : null;
  const readSeconds = 14 * 60;
  return {
    user: { id: "u-kid", displayName: "Mia" },
    goal,
    today: { date: localTime(now, tz).date, readSeconds, goalSeconds, met: goalSeconds != null && readSeconds >= goalSeconds },
    month: { month: localTime(now, tz).month, books: 3, goalBooks: goal?.booksPerMonth ?? null, met: goal?.booksPerMonth != null && 3 >= goal.booksPerMonth },
    streakDays: 7,
    totalSeconds: 9 * 3600,
    booksFinished: 5,
    badges: BADGES.map((b) => ({ ...b, earnedAt: earned[b.id] ?? null })),
    stickers,
    fresh,
    bedtime: demoBedtimeNow(),
  };
}

export const demoRewardsApi: RewardsApi = {
  summary: () => delay(demoSummary()),
  markSeen: async (ids) => save(DEMO_SEEN, [...load<string[]>(DEMO_SEEN, []), ...ids]),
  bedtime: () => delay(demoBedtimeNow()),
  settings: (kidId) =>
    delay({
      kid: { id: kidId, displayName: "Mia" },
      canEdit: true,
      goal: load<ReadingGoal | null>(DEMO_GOAL, { minutesPerDay: 20, booksPerMonth: 4, timeZone: browserTimeZone() }),
      bedtime: load(DEMO_BEDTIME, { ...DEFAULT_BEDTIME, timeZone: browserTimeZone() }),
      bedtimeNow: demoBedtimeNow(),
    }),
  saveGoal: async (_kidId, goal) => {
    const g = goal.minutesPerDay == null && goal.booksPerMonth == null ? null : goal;
    save(DEMO_GOAL, g);
    return delay(g);
  },
  saveBedtime: async (_kidId, bedtime) => {
    save(DEMO_BEDTIME, bedtime);
    return delay({ bedtime, bedtimeNow: demoBedtimeNow() });
  },
};

export const rewardsApi: RewardsApi = isDemo ? demoRewardsApi : httpRewardsApi;
