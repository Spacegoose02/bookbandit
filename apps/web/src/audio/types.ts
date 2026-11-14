/** Shapes of the Audiobookshelf playback API (apps/server/src/integrations/README.md). */

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
}

/** PUT /api/books/:id/audio/progress */
export interface AudioProgressUpdate {
  currentTime: number;
  duration: number;
  finished?: boolean;
  deviceName?: string;
  clientUpdatedAt: number;
}
