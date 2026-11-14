/**
 * Listening API: Audiobookshelf playback through Bookbandit, and listening progress.
 * Demo mode serves generated tunes and keeps progress in localStorage.
 */
import { api, isDemo, request } from "../api/client";
import { makeDemoTrack } from "./demoAudio";
import type { AudioBook, AudioProgress, AudioProgressUpdate } from "./types";

export interface AudioApi {
  audio(bookId: string): Promise<AudioBook>;
  putProgress(bookId: string, update: AudioProgressUpdate, opts?: { keepalive?: boolean }): Promise<{ applied: boolean; progress: AudioProgress }>;
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

export const demoAudioApi: AudioApi = {
  async audio(bookId) {
    const book = await api.book(bookId); // 404s like the server for books the profile can't see
    if (!book.absItemId) throw Object.assign(new Error("This book has no audiobook"), { status: 404, notFound: true });
    const a = demoBook(bookId, book.title);
    return { ...a, coverUrl: book.coverPath ?? "", author: book.authors?.[0]?.name ?? a.author };
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
