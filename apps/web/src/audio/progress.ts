/**
 * Listening progress: saved to the server every so often while playing, on pause and when the
 * page is hidden. A save that fails (offline) waits in localStorage and goes with the next one;
 * the server keeps whichever position has the newest clientUpdatedAt.
 */
import type { AudioApi } from "./api";
import type { AudioProgressUpdate } from "./types";

const PENDING = (bookId: string) => `bb-audio-pending-${bookId}`;

export function deviceName(): string {
  try {
    const saved = localStorage.getItem("bb-device-name");
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const ua = navigator.userAgent;
  return /Android/i.test(ua) ? "Android tablet" : /iPad|iPhone/i.test(ua) ? "iPad" : "Web browser";
}

export async function saveAudioProgress(
  api: AudioApi,
  bookId: string,
  currentTime: number,
  duration: number,
  opts: { keepalive?: boolean; finished?: boolean } = {},
): Promise<void> {
  const update: AudioProgressUpdate = {
    currentTime,
    duration,
    finished: opts.finished,
    deviceName: deviceName(),
    clientUpdatedAt: Date.now(),
  };
  try {
    await api.putProgress(bookId, update, { keepalive: opts.keepalive });
    localStorage.removeItem(PENDING(bookId));
  } catch {
    try {
      localStorage.setItem(PENDING(bookId), JSON.stringify(update));
    } catch {
      /* ignore */
    }
  }
}

/** A position saved while offline that is newer than what the server sent, if any. */
export function pendingAudioProgress(bookId: string, serverUpdatedAt: number | null): AudioProgressUpdate | null {
  try {
    const raw = localStorage.getItem(PENDING(bookId));
    if (!raw) return null;
    const p = JSON.parse(raw) as AudioProgressUpdate;
    return serverUpdatedAt == null || p.clientUpdatedAt > serverUpdatedAt ? p : null;
  } catch {
    return null;
  }
}
