/** A reading position, in whichever unit fits the format. */
export type ReadingLocator =
  | { kind: "epub"; cfi: string; percent: number }
  | { kind: "page"; page: number; totalPages: number }
  | { kind: "audio"; seconds: number; durationSeconds: number };

export interface ProgressUpdate {
  bookId: string;
  locator: ReadingLocator;
  /** Client clock, ISO 8601. Server stores its own receive time too. */
  updatedAt: string;
  deviceName: string;
  finished?: boolean;
}

/**
 * Newest position wins. Returns true when `incoming` should replace `current`.
 */
export function isNewerProgress(
  current: { updatedAt: string } | null | undefined,
  incoming: { updatedAt: string },
): boolean {
  if (!current) return true;
  return Date.parse(incoming.updatedAt) > Date.parse(current.updatedAt);
}

/** How far through the book a locator is, as a fraction from 0 to 1. */
export function locatorPercent(locator: ReadingLocator): number {
  const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  switch (locator.kind) {
    case "epub":
      return clamp(locator.percent);
    case "page":
      return locator.totalPages > 0 ? clamp(locator.page / locator.totalPages) : 0;
    case "audio":
      return locator.durationSeconds > 0 ? clamp(locator.seconds / locator.durationSeconds) : 0;
  }
}

/** A saved reading position, as the sync API returns it. Times are ms since epoch. */
export interface ProgressRecord {
  bookId: string;
  locator: ReadingLocator;
  /** 0 to 1 */
  percent: number;
  finished: boolean;
  deviceName: string | null;
  clientUpdatedAt: number;
  serverUpdatedAt: number;
}

export const BOOKMARK_KINDS = ["bookmark", "highlight", "sticker"] as const;
export type BookmarkKind = (typeof BOOKMARK_KINDS)[number];

/** A bookmark, highlight or sticker, as the sync API returns it. */
export interface BookmarkRecord {
  id: string;
  bookId: string;
  kind: BookmarkKind;
  locator: ReadingLocator;
  /** Highlighted text, or the sticker's name for kind "sticker". */
  text: string | null;
  note: string | null;
  color: string | null;
  createdAt: number;
  /** Set when deleted; sync clients drop the local copy. */
  deletedAt: number | null;
}
