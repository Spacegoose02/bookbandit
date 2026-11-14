/**
 * Keeping Bookbandit and Audiobookshelf in step while the family uses both.
 *
 * Each person can have their own ABS account (an ABS API key made for their ABS user, stored
 * sealed in `abs_accounts`). With it:
 * - Write-back: after a listening position is saved here, it is pushed to ABS in the background.
 *   Newest wins: if ABS has a newer position (they listened in the ABS app), Bookbandit takes
 *   that one instead of overwriting it.
 * - Pull: opening the player asks ABS for the person's position first (short timeout), so a
 *   chapter listened to in the ABS app shows up here.
 * - Import: every position, finished flag and bookmark for books linked to ABS items.
 *
 * Only books linked to an ABS item (`books.abs_item_id`) take part. A local audiobook of the same
 * book shares the timeline, so its positions go to ABS too.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/client.js";
import { books } from "../../db/schema.js";
import { absAccounts, audioBookmarks } from "../../audio/schema.js";
import { sourceFor, sourceKeys } from "../../audio/sources.js";
import { audioProgress } from "../schema.js";
import type { SecretBox } from "../secrets.js";
import { getAbsSettings } from "../settings.js";
import { AudiobookshelfClient, type AbsMediaProgress, type FetchLike } from "./client.js";

export const ABS_DEVICE = "Audiobookshelf";
/** Positions closer than this are the same place; no write needed. */
const SAME_PLACE_SECONDS = 2;

export interface AbsSyncOptions {
  db: Db;
  box: SecretBox;
  fetchImpl: FetchLike;
  log?: FastifyBaseLogger;
  /** How long the player waits for ABS before opening with the local position. */
  pullTimeoutMs?: number;
}

export interface ImportReport {
  userId: string;
  absUsername: string;
  dryRun: boolean;
  /** Positions taken from ABS (newer than what Bookbandit had). */
  imported: number;
  /** Of those, marked finished. */
  finished: number;
  /** ABS positions older than the one here, left alone. */
  keptNewer: number;
  /** ABS items with a position that aren't linked to any book here (auto-link them first). */
  unlinked: number;
  bookmarksImported: number;
  bookmarksSkipped: number;
  books: { bookId: string; title: string; currentTime: number; duration: number; finished: boolean }[];
}

type ProgressRow = typeof audioProgress.$inferSelect;

export class AbsSync {
  private inflight = new Map<string, Promise<void>>();
  private again = new Set<string>();

  constructor(private readonly opts: AbsSyncOptions) {}

  /** A client for this person's own ABS account, or null when they have none or ABS is off. */
  clientFor(userId: string, timeoutMs?: number): { client: AudiobookshelfClient; account: typeof absAccounts.$inferSelect } | null {
    const { db, box } = this.opts;
    const s = getAbsSettings(db, box);
    if (!s?.enabled) return null;
    const account = db.select().from(absAccounts).where(eq(absAccounts.userId, userId)).get();
    if (!account) return null;
    let token: string;
    try {
      token = box.open(account.tokenSealed);
    } catch {
      return null;
    }
    return { client: new AudiobookshelfClient(s.url, token, this.opts.fetchImpl, timeoutMs), account };
  }

  /** Checks a token against ABS and returns whose it is. */
  async whoAmI(token: string): Promise<{ id: string; username: string }> {
    const s = getAbsSettings(this.opts.db, this.opts.box);
    if (!s?.enabled) throw Object.assign(new Error("Connect Audiobookshelf first"), { statusCode: 503 });
    const me = await new AudiobookshelfClient(s.url, token, this.opts.fetchImpl).me();
    return { id: me.id, username: me.username };
  }

  private progressRow(userId: string, bookId: string): ProgressRow | undefined {
    return this.opts.db
      .select()
      .from(audioProgress)
      .where(and(eq(audioProgress.userId, userId), eq(audioProgress.bookId, bookId)))
      .get();
  }

  /** Takes an ABS position into audio_progress when it is newer than ours. Returns true if taken. */
  private adopt(userId: string, bookId: string, remote: AbsMediaProgress, dryRun = false): boolean {
    const { db } = this.opts;
    const book = db.select({ id: books.id, absItemId: books.absItemId }).from(books).where(eq(books.id, bookId)).get();
    if (!book) return false;
    const source = sourceFor(db, book);
    if (!source) return false;
    const current = this.progressRow(userId, bookId);
    const valid = current && sourceKeys(db, book).includes(current.absItemId);
    if (valid && current.clientUpdatedAt >= remote.lastUpdate) return false;
    if (dryRun) return true;
    const duration = remote.duration || current?.duration || 0;
    const values = {
      userId,
      bookId,
      absItemId: source.key,
      currentTime: Math.max(0, Math.min(remote.currentTime, duration || remote.currentTime)),
      duration,
      finished: remote.isFinished,
      deviceName: ABS_DEVICE,
      clientUpdatedAt: remote.lastUpdate,
      serverUpdatedAt: Date.now(),
    };
    db.insert(audioProgress)
      .values(values)
      .onConflictDoUpdate({ target: [audioProgress.userId, audioProgress.bookId], set: values })
      .run();
    return true;
  }

  /**
   * Before the player opens: take the person's ABS position if it is newer. Never throws and
   * never waits longer than the pull timeout; ABS being down just means the local position.
   */
  async pull(userId: string, bookId: string, absItemId: string | null): Promise<void> {
    if (!absItemId) return;
    const conn = this.clientFor(userId, this.opts.pullTimeoutMs ?? 2500);
    if (!conn) return;
    try {
      const remote = await conn.client.progress(absItemId);
      if (remote) this.adopt(userId, bookId, remote);
    } catch (err) {
      this.opts.log?.debug({ err }, "audiobookshelf pull failed");
    }
  }

  /** After a position is saved here: push it to ABS in the background (coalesced per book). */
  schedulePush(userId: string, bookId: string): void {
    const key = `${userId}:${bookId}`;
    if (this.inflight.has(key)) {
      this.again.add(key);
      return;
    }
    const run = async (): Promise<void> => {
      try {
        await this.push(userId, bookId);
      } catch (err) {
        this.opts.log?.warn({ err }, "audiobookshelf write-back failed");
      }
      if (this.again.delete(key)) return run();
    };
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
  }

  /** Resolves when every scheduled push has finished (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight.values()]);
  }

  async push(userId: string, bookId: string): Promise<"pushed" | "pulled" | "same" | "skipped"> {
    const { db } = this.opts;
    const book = db.select({ id: books.id, absItemId: books.absItemId }).from(books).where(eq(books.id, bookId)).get();
    if (!book?.absItemId) return "skipped";
    const conn = this.clientFor(userId);
    if (!conn || !conn.account.writeBack) return "skipped";
    const ours = this.progressRow(userId, bookId);
    if (!ours || !sourceKeys(db, book).includes(ours.absItemId)) return "skipped";

    const setAccount = (fields: Partial<typeof absAccounts.$inferInsert>) =>
      db.update(absAccounts).set(fields).where(eq(absAccounts.userId, userId)).run();
    try {
      const remote = await conn.client.progress(book.absItemId);
      if (remote && remote.lastUpdate > ours.clientUpdatedAt) {
        this.adopt(userId, bookId, remote);
        return "pulled";
      }
      if (remote && Math.abs(remote.currentTime - ours.currentTime) < SAME_PLACE_SECONDS && remote.isFinished === ours.finished) {
        return "same";
      }
      await conn.client.updateProgress(book.absItemId, {
        currentTime: ours.currentTime,
        duration: ours.duration,
        isFinished: ours.finished,
      });
      setAccount({ lastPushAt: Date.now(), lastError: null });
      return "pushed";
    } catch (err) {
      setAccount({ lastError: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Imports one person's ABS positions, finished flags and bookmarks. */
  async importFor(userId: string, opts: { dryRun?: boolean } = {}): Promise<ImportReport> {
    const { db } = this.opts;
    const dryRun = !!opts.dryRun;
    const conn = this.clientFor(userId);
    if (!conn) throw Object.assign(new Error("This person has no Audiobookshelf account linked"), { statusCode: 409 });
    const me = await conn.client.me();

    const linked = new Map(
      db
        .select({ id: books.id, title: books.title, absItemId: books.absItemId })
        .from(books)
        .where(isNotNull(books.absItemId))
        .all()
        .map((b) => [b.absItemId!, b]),
    );
    const report: ImportReport = {
      userId,
      absUsername: me.username,
      dryRun,
      imported: 0,
      finished: 0,
      keptNewer: 0,
      unlinked: 0,
      bookmarksImported: 0,
      bookmarksSkipped: 0,
      books: [],
    };

    for (const p of me.mediaProgress) {
      if (p.episodeId) continue; // podcasts
      const book = linked.get(p.libraryItemId);
      if (!book) {
        report.unlinked++;
        continue;
      }
      if (this.adopt(userId, book.id, p, dryRun)) {
        report.imported++;
        if (p.isFinished) report.finished++;
        report.books.push({ bookId: book.id, title: book.title, currentTime: p.currentTime, duration: p.duration, finished: p.isFinished });
      } else report.keptNewer++;
    }

    const now = Date.now();
    for (const b of me.bookmarks) {
      const book = linked.get(b.libraryItemId);
      if (!book) continue;
      const existing = db
        .select({ time: audioBookmarks.time })
        .from(audioBookmarks)
        .where(and(eq(audioBookmarks.userId, userId), eq(audioBookmarks.bookId, book.id)))
        .all();
      if (existing.some((e) => Math.abs(e.time - b.time) < 1)) {
        report.bookmarksSkipped++;
        continue;
      }
      report.bookmarksImported++;
      if (dryRun) continue;
      db.insert(audioBookmarks)
        .values({
          userId,
          bookId: book.id,
          time: b.time,
          note: b.title.trim() || null,
          origin: "audiobookshelf",
          createdAt: b.createdAt || now,
          updatedAt: now,
        })
        .run();
    }

    if (!dryRun) db.update(absAccounts).set({ lastImportAt: now, lastError: null }).where(eq(absAccounts.userId, userId)).run();
    return report;
  }
}
