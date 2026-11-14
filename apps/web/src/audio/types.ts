/** Shapes of the listening API (apps/server/src/audio/README.md): local audiobooks and Audiobookshelf. */

export interface AudioTrack {
  index: number;
  title: string;
  /** Where this file starts in the whole book, in seconds. */
  startOffset: number;
  duration: number;
  mimeType: string;
  url: string;
}

export interface AudioChapter {
  start: number;
  end: number;
  title: string;
}

export interface AudioProgress {
  currentTime: number;
  duration: number;
  percent: number;
  finished: boolean;
  deviceName: string | null;
  clientUpdatedAt: number;
  serverUpdatedAt: number;
}

/** GET /api/books/:id/audio */
export interface AudioBook {
  bookId: string;
  title: string;
  author: string | null;
  narrator: string | null;
  duration: number;
  chapters: AudioChapter[];
  coverUrl: string;
  tracks: AudioTrack[];
  progress: AudioProgress | null;
  /** Where the audio comes from. Older servers leave it out (Audiobookshelf). */
  source?: "local" | "audiobookshelf";
  /** Remembered per book. Older servers leave it out. */
  prefs?: AudioPrefs;
}

export interface AudioPrefs {
  speed: number;
  skipSilence: boolean;
}

/** A listening bookmark with an optional note. */
export interface AudioBookmark {
  id: string;
  bookId: string;
  /** Seconds into the whole book. */
  time: number;
  note: string | null;
  origin: "bookbandit" | "audiobookshelf";
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

/** PUT /api/books/:id/audio/progress */
export interface AudioProgressUpdate {
  currentTime: number;
  duration: number;
  finished?: boolean;
  deviceName?: string;
  clientUpdatedAt: number;
}
