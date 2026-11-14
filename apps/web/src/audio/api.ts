/**
 * Listening API: Audiobookshelf playback through Bookbandit, and listening progress.
 * Demo mode serves generated tunes and keeps progress in localStorage.
 */
import { api, isDemo, request } from "../api/client";
import { makeDemoTrack } from "./demoAudio";
import type { AudioBook, AudioBookmark, AudioPrefs, AudioProgress, AudioProgressUpdate } from "./types";

export interface AudioApi {
  audio(bookId: string): Promise<AudioBook>;
  putProgress(bookId: string, update: AudioProgressUpdate, opts?: { keepalive?: boolean }): Promise<{ applied: boolean; progress: AudioProgress }>;
  putPrefs(bookId: string, prefs: Partial<AudioPrefs>): Promise<AudioPrefs>;
  bookmarks(bookId: string): Promise<AudioBookmark[]>;
  addBookmark(bookId: string, time: number, note?: string): Promise<AudioBookmark>;
  editBookmark(id: string, patch: { note?: string | null; time?: number }): Promise<AudioBookmark>;
  deleteBookmark(id: string): Promise<void>;
}

const enc = encodeURIComponent;

export const httpAudioApi: AudioApi = {
  audio: (bookId) => request(`/api/books/${enc(bookId)}/audio`),
  putProgress: (bookId, update, opts) =>
    request(`/api/books/${enc(bookId)}/audio/progress`, {
      method: "PUT",
      body: JSON.stringify(update),
      keepalive: opts?.keepalive,
    }),
  putPrefs: (bookId, prefs) => request(`/api/books/${enc(bookId)}/audio/prefs`, { method: "PUT", body: JSON.stringify(prefs) }),
  bookmarks: async (bookId) => (await request<{ items: AudioBookmark[] }>(`/api/books/${enc(bookId)}/audio/bookmarks`)).items,
  addBookmark: (bookId, time, note) =>
    request(`/api/books/${enc(bookId)}/audio/bookmarks`, { method: "POST", body: JSON.stringify({ time, ...(note ? { note } : {}) }) }),
  editBookmark: (id, patch) => request(`/api/audio/bookmarks/${enc(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBookmark: async (id) => {
    await request<void>(`/api/audio/bookmarks/${enc(id)}`, { method: "DELETE" });
  },
};

/** Demo books that "have" an audiobook (see DEMO_AUDIO_BOOKS in api/demo.ts). */
const DEMO_TRACK_SECONDS = 45;
const trackUrls = new Map<string, string>();

function demoBook(bookId: string, title: string): AudioBook {
  const tracks = [0, 1, 2].map((i) => {
    const key = `${bookId}-${i}`;
    if (!trackUrls.has(key)) trackUrls.set(key, makeDemoTrack(DEMO_TRACK_SECONDS, i * 3));
    return {
      index: i,
      title: `Part ${i + 1}`,
      startOffset: i * DEMO_TRACK_SECONDS,
      duration: DEMO_TRACK_SECONDS,
      mimeType: "audio/wav",
      url: trackUrls.get(key)!,
    };
  });
  const chapterTitles = ["Once upon a time", "The missing page", "A clue in the garden", "Home for supper", "Goodnight"];
  const len = (DEMO_TRACK_SECONDS * 3) / chapterTitles.length;
  return {
    bookId,
    title,
    author: "Demo Author",
    narrator: "Barnaby",
    duration: DEMO_TRACK_SECONDS * 3,
    chapters: chapterTitles.map((t, i) => ({ start: i * len, end: (i + 1) * len, title: t })),
    coverUrl: "",
    tracks,
    progress: readDemoProgress(bookId),
  };
}

function readDemoProgress(bookId: string): AudioProgress | null {
  try {
    const raw = localStorage.getItem(`bb-demo-audio-${bookId}`);
    return raw ? (JSON.parse(raw) as AudioProgress) : null;
  } catch {
    return null;
  }
}

/** Demo books whose audio "comes from" a local folder rather than Audiobookshelf. */
const DEMO_LOCAL = new Set(["b1", "b3"]);
const DEMO_BOOKMARKS = "bb-demo-audio-bookmarks";
const DEMO_SEED: AudioBookmark[] = [
  { id: "bm-seed-1", bookId: "b1", time: 38, note: "Barnaby finds the first clue", origin: "bookbandit", createdAt: 1, updatedAt: 1, deleted: false },
  { id: "bm-seed-2", bookId: "b1", time: 96, note: "Read this bit again with Emma", origin: "audiobookshelf", createdAt: 2, updatedAt: 2, deleted: false },
];

function readDemo<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeDemo(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function demoBookmarks(): AudioBookmark[] {
  return readDemo<AudioBookmark[]>(DEMO_BOOKMARKS) ?? DEMO_SEED.map((b) => ({ ...b }));
}

export const demoAudioApi: AudioApi = {
  async audio(bookId) {
    const book = await api.book(bookId); // 404s like the server for books the profile can't see
    if (!book.absItemId && !book.hasAudio) throw Object.assign(new Error("This book has no audiobook"), { status: 404, notFound: true });
    const a = demoBook(bookId, book.title);
    return {
      ...a,
      coverUrl: book.coverPath ?? "",
      author: book.authors?.[0]?.name ?? a.author,
      source: DEMO_LOCAL.has(bookId) ? "local" : "audiobookshelf",
      prefs: readDemo<AudioPrefs>(`bb-demo-audio-prefs-${bookId}`) ?? { speed: 1, skipSilence: false },
    };
  },
  async putPrefs(bookId, prefs) {
    const next = { ...(readDemo<AudioPrefs>(`bb-demo-audio-prefs-${bookId}`) ?? { speed: 1, skipSilence: false }), ...prefs };
    writeDemo(`bb-demo-audio-prefs-${bookId}`, next);
    return next;
  },
  async bookmarks(bookId) {
    return demoBookmarks().filter((b) => b.bookId === bookId && !b.deleted).sort((a, b) => a.time - b.time);
  },
  async addBookmark(bookId, time, note) {
    const now = Date.now();
    const b: AudioBookmark = { id: `bm-${now}-${Math.random().toString(36).slice(2, 6)}`, bookId, time, note: note?.trim() || null, origin: "bookbandit", createdAt: now, updatedAt: now, deleted: false };
    writeDemo(DEMO_BOOKMARKS, [...demoBookmarks(), b]);
    return b;
  },
  async editBookmark(id, patch) {
    const all = demoBookmarks();
    const b = all.find((x) => x.id === id);
    if (!b) throw Object.assign(new Error("Not found"), { status: 404, notFound: true });
    if (patch.time != null) b.time = patch.time;
    if (patch.note !== undefined) b.note = patch.note?.trim() || null;
    b.updatedAt = Date.now();
    writeDemo(DEMO_BOOKMARKS, all);
    return b;
  },
  async deleteBookmark(id) {
    writeDemo(
      DEMO_BOOKMARKS,
      demoBookmarks().filter((b) => b.id !== id),
    );
  },
  async putProgress(bookId, u) {
    const progress: AudioProgress = {
      currentTime: u.currentTime,
      duration: u.duration,
      percent: u.duration ? u.currentTime / u.duration : 0,
      finished: u.finished ?? false,
      deviceName: u.deviceName ?? null,
      clientUpdatedAt: u.clientUpdatedAt,
      serverUpdatedAt: Date.now(),
    };
    try {
      localStorage.setItem(`bb-demo-audio-${bookId}`, JSON.stringify(progress));
    } catch {
      /* ignore */
    }
    return { applied: true, progress };
  },
};

export const audioApi: AudioApi = isDemo ? demoAudioApi : httpAudioApi;
