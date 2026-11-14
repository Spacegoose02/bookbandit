/**
 * Pure helpers for multi-file audiobooks: Audiobookshelf splits a book into tracks, but the
 * player, chapters, progress and sleep timer all work in "seconds into the whole book".
 */
import type { AudioChapter, AudioTrack } from "./types";

/** Which track holds book time `t`, and how far into that track. Clamps to the ends. */
export function locate(tracks: Pick<AudioTrack, "startOffset" | "duration">[], t: number): { index: number; offset: number } {
  if (!tracks.length) return { index: 0, offset: 0 };
  const time = Math.max(0, t);
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i]!;
    if (time < tr.startOffset + tr.duration || i === tracks.length - 1) {
      return { index: i, offset: Math.min(Math.max(0, time - tr.startOffset), tr.duration) };
    }
  }
  return { index: 0, offset: 0 };
}

export function totalDuration(tracks: Pick<AudioTrack, "startOffset" | "duration">[]): number {
  const last = tracks[tracks.length - 1];
  return last ? last.startOffset + last.duration : 0;
}

/** Index of the chapter playing at `t` (-1 when there are no chapters). */
export function chapterAt(chapters: AudioChapter[], t: number): number {
  let found = -1;
  for (let i = 0; i < chapters.length; i++) if (t >= chapters[i]!.start) found = i;
  return found;
}

/** "1:02:03" or "4:05". */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type SleepTimer =
  | { kind: "off" }
  | { kind: "minutes"; minutes: number; endsAt: number }
  | { kind: "chapter"; chapterEnd: number };

/** Seconds of fade-out before the sleep timer pauses. */
export const SLEEP_FADE_SECONDS = 10;

/**
 * How loud to play (0..1) and whether to stop, for a sleep timer. Fades out over the last
 * SLEEP_FADE_SECONDS so a sleepy listener isn't jolted by a sudden stop.
 */
export function sleepState(timer: SleepTimer, now: number, bookTime: number, rate = 1): { volume: number; stop: boolean } {
  let left: number;
  if (timer.kind === "off") return { volume: 1, stop: false };
  if (timer.kind === "minutes") left = (timer.endsAt - now) / 1000;
  else left = (timer.chapterEnd - bookTime) / rate;
  if (left <= 0) return { volume: 0, stop: true };
  return { volume: Math.min(1, left / SLEEP_FADE_SECONDS), stop: false };
}

/** Remaining seconds on a sleep timer (wall clock), for the button label. */
export function sleepLeft(timer: SleepTimer, now: number, bookTime: number, rate = 1): number | null {
  if (timer.kind === "off") return null;
  if (timer.kind === "minutes") return Math.max(0, (timer.endsAt - now) / 1000);
  return Math.max(0, (timer.chapterEnd - bookTime) / rate);
}
