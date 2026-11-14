/**
 * Storyteller rules: tonight's allowance, starting stories, and crediting listening time.
 * All time is measured by the server's clock so a tablet can't report its way past a limit.
 */
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import {
  DEFAULT_STORYTELLER_SETTINGS,
  nightKey,
  STORY_COUNTS_AFTER_SECONDS,
  tonightFrom,
  type StorytellerSettings,
  type StorytellerTonight,
} from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { storytellerSessions, storytellerSettings } from "./schema.js";

/** How often the player checks in while a story plays. */
export const BEAT_INTERVAL_MS = 30_000;
/** Most listening one heartbeat can add, so a long gap (sleeping tablet) isn't billed in full. */
export const MAX_CREDIT_PER_BEAT_MS = 45_000;
/** An open session with no heartbeat for this long no longer unlocks audio. */
export const SESSION_STALE_MS = 5 * 60_000;

export type SessionRow = typeof storytellerSessions.$inferSelect;

export function getSettings(db: Db, kidId: string): StorytellerSettings {
  const row = db.select().from(storytellerSettings).where(eq(storytellerSettings.kidId, kidId)).get();
  if (!row) return { ...DEFAULT_STORYTELLER_SETTINGS };
  return {
    enabled: row.enabled,
    storiesPerNight: row.storiesPerNight,
    minutesPerNight: row.minutesPerNight,
    sleepTimerMinutes: row.sleepTimerMinutes,
    readAloud: row.readAloud,
    timeZone: row.timeZone,
    nightStartsHour: row.nightStartsHour,
  };
}

export function saveSettings(db: Db, kidId: string, s: StorytellerSettings, by: string): StorytellerSettings {
  const values = { kidId, ...s, updatedBy: by, updatedAt: Date.now() };
  db.insert(storytellerSettings)
    .values(values)
    .onConflictDoUpdate({ target: storytellerSettings.kidId, set: values })
    .run();
  return getSettings(db, kidId);
}

export function currentNight(s: StorytellerSettings, now = Date.now()): string {
  return nightKey(new Date(now), s.timeZone, s.nightStartsHour);
}

function sessionsTonight(db: Db, kidId: string, night: string): SessionRow[] {
  return db
    .select()
    .from(storytellerSessions)
    .where(and(eq(storytellerSessions.kidId, kidId), eq(storytellerSessions.night, night)))
    .orderBy(desc(storytellerSessions.startedAt))
    .all();
}

/** Books listened to for at least STORY_COUNTS_AFTER_SECONDS tonight (across sessions). */
function countedBooks(sessions: SessionRow[]): Set<string> {
  const perBook = new Map<string, number>();
  for (const s of sessions) perBook.set(s.bookId, (perBook.get(s.bookId) ?? 0) + s.listenedMs);
  return new Set([...perBook].filter(([, ms]) => ms >= STORY_COUNTS_AFTER_SECONDS * 1000).map(([id]) => id));
}

export function tonight(db: Db, kidId: string, now = Date.now()): StorytellerTonight {
  const s = getSettings(db, kidId);
  const night = currentNight(s, now);
  const sessions = sessionsTonight(db, kidId, night);
  const secondsUsed = sessions.reduce((sum, x) => sum + x.listenedMs, 0) / 1000;
  return tonightFrom(night, { storiesUsed: countedBooks(sessions).size, secondsUsed }, s);
}

/** Credit wall-clock time since the last heartbeat (capped), if the story was playing. */
function credit(session: SessionRow, now: number, playing: boolean): number {
  if (!playing || session.endedAt != null) return session.listenedMs;
  const delta = Math.max(0, Math.min(now - session.lastBeatAt, MAX_CREDIT_PER_BEAT_MS));
  return session.listenedMs + delta;
}

export type StartResult =
  | { ok: true; session: SessionRow; tonight: StorytellerTonight }
  | { ok: false; tonight: StorytellerTonight };

/**
 * Start a story. Closes any story still open on another device first. Refused when tonight's
 * allowance is used up, except that the story the kid was just listening to may be resumed
 * while there are minutes left (a story limit stops the *next* story, not the current one).
 */
export function startStory(
  db: Db,
  kidId: string,
  bookId: string,
  mode: SessionRow["mode"],
  now = Date.now(),
): StartResult {
  const s = getSettings(db, kidId);
  const night = currentNight(s, now);

  db.update(storytellerSessions)
    .set({ endedAt: now })
    .where(and(eq(storytellerSessions.kidId, kidId), isNull(storytellerSessions.endedAt)))
    .run();

  const before = tonight(db, kidId, now);
  if (before.goodnight) {
    const minutesLeft = before.secondsLeft == null || before.secondsLeft > 0;
    const latest = sessionsTonight(db, kidId, night)[0];
    const resuming = latest && latest.bookId === bookId && !latest.completed && minutesLeft;
    if (!resuming) return { ok: false, tonight: before };
  }

  const session: SessionRow = {
    id: crypto.randomUUID(),
    kidId,
    bookId,
    mode,
    night,
    startedAt: now,
    lastBeatAt: now,
    endedAt: null,
    completed: false,
    listenedMs: 0,
  };
  db.insert(storytellerSessions).values(session).run();
  return { ok: true, session, tonight: tonight(db, kidId, now) };
}

export interface BeatResult {
  /** The player must stop: tonight's minutes are used up (or the session already ended). */
  stop: boolean;
  tonight: StorytellerTonight;
}

export function beat(db: Db, session: SessionRow, playing: boolean, now = Date.now()): BeatResult {
  if (session.endedAt != null) return { stop: true, tonight: tonight(db, session.kidId, now) };
  const listenedMs = credit(session, now, playing);
  db.update(storytellerSessions).set({ listenedMs, lastBeatAt: now }).where(eq(storytellerSessions.id, session.id)).run();
  const t = tonight(db, session.kidId, now);
  const outOfMinutes = t.secondsLeft === 0;
  if (outOfMinutes) {
    db.update(storytellerSessions).set({ endedAt: now }).where(eq(storytellerSessions.id, session.id)).run();
  }
  return { stop: outOfMinutes, tonight: t };
}

export function endStory(db: Db, session: SessionRow, playing: boolean, completed: boolean, now = Date.now()) {
  if (session.endedAt == null) {
    db.update(storytellerSessions)
      .set({ listenedMs: credit(session, now, playing), lastBeatAt: now, endedAt: now, completed })
      .where(eq(storytellerSessions.id, session.id))
      .run();
  } else if (completed && !session.completed) {
    db.update(storytellerSessions).set({ completed }).where(eq(storytellerSessions.id, session.id)).run();
  }
  return tonight(db, session.kidId, now);
}

/**
 * May this kid stream this audiobook right now? Kids with storyteller mode on can only play
 * audio inside a live storyteller session for that book, with minutes left tonight.
 * Everyone else (adults, kids without storyteller mode) is unaffected.
 */
export function audioAllowed(db: Db, kidId: string, bookId: string, now = Date.now()): boolean {
  const s = getSettings(db, kidId);
  if (!s.enabled) return true;
  const open = db
    .select()
    .from(storytellerSessions)
    .where(
      and(
        eq(storytellerSessions.kidId, kidId),
        eq(storytellerSessions.bookId, bookId),
        isNull(storytellerSessions.endedAt),
      ),
    )
    .all()
    .find((x) => x.mode === "audio" && now - x.lastBeatAt < SESSION_STALE_MS);
  if (!open) return false;
  const t = tonight(db, kidId, now);
  return t.secondsLeft == null || t.secondsLeft > 0;
}

export function recentSessions(db: Db, kidId: string, since: number): SessionRow[] {
  return db
    .select()
    .from(storytellerSessions)
    .where(and(eq(storytellerSessions.kidId, kidId), gte(storytellerSessions.startedAt, since)))
    .orderBy(desc(storytellerSessions.startedAt))
    .limit(200)
    .all();
}
