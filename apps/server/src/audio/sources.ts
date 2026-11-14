/**
 * Where a book's audio comes from. A local audiobook (scanned from AUDIOBOOKS_DIR) wins over an
 * Audiobookshelf link, so the family keeps listening when ABS is switched off.
 *
 * Positions live in `audio_progress` (integrations/schema.ts), keyed by a source key in its
 * `abs_item_id` column: the ABS item id for ABS audio, `local:<audiobook id>` for local audio.
 * A position recorded against either of the book's current sources is valid, so a book that
 * moves from ABS to a local copy of the same files keeps everyone's place.
 */
import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import { audioProgress } from "../integrations/schema.js";
import { audiobooks } from "./schema.js";

type Tx = Pick<Db, "select" | "selectDistinct">;
export type AudiobookRow = typeof audiobooks.$inferSelect;
type BookRow = Pick<typeof books.$inferSelect, "id" | "absItemId">;

export type AudioSource =
  | { kind: "local"; key: string; audiobook: AudiobookRow }
  | { kind: "abs"; key: string; absItemId: string };

export const localKey = (audiobookId: string) => `local:${audiobookId}`;

/** The book's local audiobook (the first folder, when someone has two copies). */
export function localAudiobookFor(db: Tx, bookId: string): AudiobookRow | undefined {
  return db.select().from(audiobooks).where(eq(audiobooks.bookId, bookId)).orderBy(asc(audiobooks.relPath)).get();
}

export function sourceFor(db: Tx, book: BookRow): AudioSource | null {
  const local = localAudiobookFor(db, book.id);
  if (local) return { kind: "local", key: localKey(local.id), audiobook: local };
  if (book.absItemId) return { kind: "abs", key: book.absItemId, absItemId: book.absItemId };
  return null;
}

/** Every source key a stored position may carry and still count for this book. */
export function sourceKeys(db: Tx, book: BookRow): string[] {
  const keys = db
    .select({ id: audiobooks.id })
    .from(audiobooks)
    .where(eq(audiobooks.bookId, book.id))
    .all()
    .map((r) => localKey(r.id));
  if (book.absItemId) keys.push(book.absItemId);
  return keys;
}

/** Of `ids`, the books that have a local audiobook. */
export function bookIdsWithLocalAudio(db: Tx, ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  return new Set(
    db
      .selectDistinct({ bookId: audiobooks.bookId })
      .from(audiobooks)
      .where(inArray(audiobooks.bookId, ids))
      .all()
      .map((r) => r.bookId),
  );
}

export function hasAudio(db: Tx, book: BookRow): boolean {
  return !!book.absItemId || bookIdsWithLocalAudio(db, [book.id]).size > 0;
}

/** SQL: the audio_progress row in this query belongs to one of its book's current sources. */
export function progressMatchesBook(): SQL {
  return sql`(${audioProgress.absItemId} = ${books.absItemId} or ${audioProgress.absItemId} in (select 'local:' || ${audiobooks.id} from ${audiobooks} where ${audiobooks.bookId} = ${books.id}))`;
}
