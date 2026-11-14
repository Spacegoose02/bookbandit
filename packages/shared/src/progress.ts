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
