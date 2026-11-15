/**
 * Storyteller API (apps/server/src/storyteller/README.md). The server enforces the nightly
 * limits; the demo version imitates it in localStorage so the screens can be tried offline.
 */
import {
  DEFAULT_STORYTELLER_SETTINGS,
  nightKey,
  STORY_COUNTS_AFTER_SECONDS,
  tonightFrom,
  type StorytellerMode,
  type StorytellerSettings,
  type StorytellerTonight,
} from "@bookbandit/shared";
import { api, ApiError, isDemo, request } from "../api/client";
import type { BookSummary } from "../api/types";
import { newId } from "../app/uuid";

export interface Story {
  id: string;
  title: string;
  coverPath: string | null;
  rating: BookSummary["rating"];
  hasAudio: boolean;
  canReadAloud: boolean;
}

export interface StorytellerScreen {
  kid: { id: string; displayName: string };
  settings: StorytellerSettings;
  canEdit: boolean;
  tonight: StorytellerTonight;
  beatIntervalMs: number;
  stories: Story[];
}

export interface StartedStory {
  session: { id: string; bookId: string; mode: StorytellerMode; startedAt: number };
  tonight: StorytellerTonight;
  beatIntervalMs: number;
}

export interface HistoryItem {
  id: string;
  bookId: string;
  title: string;
  mode: StorytellerMode;
  night: string;
  startedAt: number;
  endedAt: number | null;
  completed: boolean;
  listenedSeconds: number;
}

/** Thrown by start() when tonight's stories or minutes are used up. */
export class GoodnightError extends Error {
  constructor(public tonight: StorytellerTonight) {
    super("That's all the stories for tonight");
  }
}

export interface KidProfile {
  id: string;
  displayName: string;
  avatar: string | null;
}

export interface StorytellerApi {
  /** Kids this grown-up manages (linked kids; every kid for an admin). */
  kids(): Promise<KidProfile[]>;
  /** Put a book on (or take it off) a kid's storyteller shelf. */
  setStory(kidId: string, bookId: string, on: boolean): Promise<void>;
  screen(kidId: string): Promise<StorytellerScreen>;
  saveSettings(kidId: string, s: StorytellerSettings): Promise<{ settings: StorytellerSettings; tonight: StorytellerTonight }>;
  history(kidId: string, days?: number): Promise<HistoryItem[]>;
  start(bookId: string, mode: StorytellerMode): Promise<StartedStory>;
  beat(sessionId: string, playing: boolean): Promise<{ stop: boolean; tonight: StorytellerTonight }>;
  end(sessionId: string, opts: { playing: boolean; completed: boolean }, keepalive?: boolean): Promise<{ tonight: StorytellerTonight }>;
}

const enc = encodeURIComponent;
const post = (body: unknown, keepalive?: boolean): RequestInit => ({ method: "POST", body: JSON.stringify(body), keepalive });

export const httpStorytellerApi: StorytellerApi = {
  kids: () =>
    request<{ users: (KidProfile & { role: string })[] }>("/api/users").then((r) =>
      r.users.filter((u) => u.role === "kid").map(({ id, displayName, avatar }) => ({ id, displayName, avatar })),
    ),
  setStory: (kidId, bookId, on) =>
    request(`/api/shelves/kids/${enc(kidId)}/books/${enc(bookId)}`, { method: "PUT", body: JSON.stringify({ storyteller: on }) }),
  screen: (kidId) => request(`/api/storyteller/kids/${enc(kidId)}`),
  saveSettings: (kidId, s) => request(`/api/storyteller/kids/${enc(kidId)}/settings`, { method: "PUT", body: JSON.stringify(s) }),
  history: (kidId, days = 7) =>
    request<{ items: HistoryItem[] }>(`/api/storyteller/kids/${enc(kidId)}/history?days=${days}`).then((r) => r.items),
  async start(bookId, mode) {
    try {
      return await request<StartedStory>("/api/storyteller/stories", post({ bookId, mode }));
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { goodnight?: boolean; tonight?: StorytellerTonight } | undefined) : undefined;
      if (body?.goodnight && body.tonight) throw new GoodnightError(body.tonight);
      throw e;
    }
  },
  beat: (id, playing) => request(`/api/storyteller/sessions/${enc(id)}/beat`, post({ playing })),
  end: (id, opts, keepalive) => request(`/api/storyteller/sessions/${enc(id)}/end`, post(opts, keepalive)),
};

// --------------------------------------------------------------------------- demo

interface DemoSession {
  id: string;
  bookId: string;
  mode: StorytellerMode;
  night: string;
  startedAt: number;
  lastBeatAt: number;
  endedAt: number | null;
  completed: boolean;
  listenedMs: number;
}

const DEMO_SETTINGS = "bb-demo-storyteller-settings";
const DEMO_SESSIONS = "bb-demo-storyteller-sessions";
const DEMO_BEAT_MS = 5_000;
const DEMO_STORIES = "bb-demo-storyteller-books";
/** Demo: which kids' books are on Mia's storyteller shelf (default: the picture books). */
const demoStoryIds = () => load<string[]>(DEMO_STORIES, ["b15", "b16", "b17", "b1", "b3", "b2"]);

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const demoSettings = (): StorytellerSettings => ({
  ...DEFAULT_STORYTELLER_SETTINGS,
  enabled: true,
  storiesPerNight: 3,
  minutesPerNight: 30,
  sleepTimerMinutes: 20,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  ...load<Partial<StorytellerSettings>>(DEMO_SETTINGS, {}),
});

function demoTonight(now = Date.now()): StorytellerTonight {
  const s = demoSettings();
  const night = nightKey(new Date(now), s.timeZone, s.nightStartsHour);
  const sessions = load<DemoSession[]>(DEMO_SESSIONS, []).filter((x) => x.night === night);
  const perBook = new Map<string, number>();
  for (const x of sessions) perBook.set(x.bookId, (perBook.get(x.bookId) ?? 0) + x.listenedMs);
  const storiesUsed = [...perBook.values()].filter((ms) => ms >= STORY_COUNTS_AFTER_SECONDS * 1000).length;
  const secondsUsed = sessions.reduce((a, x) => a + x.listenedMs, 0) / 1000;
  return tonightFrom(night, { storiesUsed, secondsUsed }, s);
}

function updateSession(id: string, f: (s: DemoSession) => DemoSession) {
  store(
    DEMO_SESSIONS,
    load<DemoSession[]>(DEMO_SESSIONS, []).map((s) => (s.id === id ? f(s) : s)),
  );
}

function credit(s: DemoSession, playing: boolean, now: number): number {
  return playing && s.endedAt == null ? s.listenedMs + Math.min(now - s.lastBeatAt, DEMO_BEAT_MS * 1.5) : s.listenedMs;
}

const demoStorytellerApi: StorytellerApi = {
  async kids() {
    return [{ id: "u-kid", displayName: "Mia", avatar: "🦖" }];
  },
  async setStory(_kidId, bookId, on) {
    const ids = demoStoryIds().filter((id) => id !== bookId);
    store(DEMO_STORIES, on ? [...ids, bookId] : ids);
  },
  async screen() {
    const books = (await api.books(new URLSearchParams({ ratings: "kids", sort: "added", limit: "50" }))).items;
    const full = await Promise.all(books.map((b) => api.book(b.id)));
    const settings = demoSettings();
    const kid = sessionStorage.getItem("bb-demo-user") === "kid";
    return {
      kid: { id: "u-kid", displayName: "Mia" },
      settings,
      canEdit: !kid,
      tonight: demoTonight(),
      beatIntervalMs: DEMO_BEAT_MS,
      stories: demoStoryIds()
        .map((id) => full.find((b) => b.id === id))
        .filter((b) => b != null)
        .slice(0, 9)
        .map((b) => ({
          id: b.id,
          title: b.title,
          coverPath: b.coverPath,
          rating: b.rating,
          hasAudio: !!b.absItemId,
          canReadAloud: settings.readAloud && !!b.files?.length,
        })),
    };
  },
  async saveSettings(_kidId, s) {
    store(DEMO_SETTINGS, s);
    return { settings: demoSettings(), tonight: demoTonight() };
  },
  async history() {
    const books = new Map((await api.books(new URLSearchParams({ limit: "100" }))).items.map((b) => [b.id, b.title]));
    return load<DemoSession[]>(DEMO_SESSIONS, [])
      .slice()
      .reverse()
      .map((s) => ({ ...s, title: books.get(s.bookId) ?? "A story", listenedSeconds: Math.round(s.listenedMs / 1000) }));
  },
  async start(bookId, mode) {
    const now = Date.now();
    const all = load<DemoSession[]>(DEMO_SESSIONS, []).map((s) => (s.endedAt == null ? { ...s, endedAt: now } : s));
    store(DEMO_SESSIONS, all);
    const t = demoTonight(now);
    if (t.goodnight) {
      const latest = all.filter((s) => s.night === t.night).at(-1);
      const resuming = latest && latest.bookId === bookId && !latest.completed && (t.secondsLeft ?? 1) > 0;
      if (!resuming) throw new GoodnightError(t);
    }
    const session: DemoSession = { id: newId(), bookId, mode, night: t.night, startedAt: now, lastBeatAt: now, endedAt: null, completed: false, listenedMs: 0 };
    store(DEMO_SESSIONS, [...all, session]);
    return { session: { id: session.id, bookId, mode, startedAt: now }, tonight: demoTonight(now), beatIntervalMs: DEMO_BEAT_MS };
  },
  async beat(id, playing) {
    const now = Date.now();
    updateSession(id, (s) => ({ ...s, listenedMs: credit(s, playing, now), lastBeatAt: now }));
    const t = demoTonight(now);
    if (t.secondsLeft === 0) updateSession(id, (s) => ({ ...s, endedAt: now }));
    return { stop: t.secondsLeft === 0, tonight: t };
  },
  async end(id, { playing, completed }) {
    const now = Date.now();
    updateSession(id, (s) => ({ ...s, listenedMs: credit(s, playing, now), lastBeatAt: now, endedAt: s.endedAt ?? now, completed }));
    return { tonight: demoTonight(now) };
  },
};

export const storytellerApi: StorytellerApi = isDemo ? demoStorytellerApi : httpStorytellerApi;
