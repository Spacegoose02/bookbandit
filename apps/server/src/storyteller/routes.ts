/**
 * Storyteller mode API. See README.md in this folder.
 *
 * - The kid's storyteller screen: their storyteller shelf (content lock applied as the kid
 *   and as the viewer) plus tonight's allowance.
 * - Parents/admins set the nightly limits; kids can never change them (CLAUDE.md rule 2).
 * - Starting a story, heartbeats and ending: the server keeps the clock.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  isValidTimeZone,
  STORYTELLER_MAX_COVERS,
  STORYTELLER_MODES,
  type StorytellerSettings,
} from "@bookbandit/shared";
import { httpError, requireReader } from "../auth/plugin.js";
import { canManage, loadVisibleUser } from "../auth/permissions.js";
import { toReader, type Reader } from "../auth/reader.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import type { Db } from "../db/client.js";
import { bookFiles, books, kidShelf } from "../db/schema.js";
import { storytellerSessions } from "./schema.js";
import { beat, endStory, getSettings, recentSessions, saveSettings, startStory, tonight, BEAT_INTERVAL_MS } from "./service.js";
import { bookIdsWithLocalAudio, hasAudio } from "../audio/sources.js";

/** Formats the web reader can open and read aloud (foliate-js). */
export const READ_ALOUD_FORMATS = ["epub", "azw3", "mobi", "fb2", "cbz"] as const;

const KidParams = z.object({ kidId: z.string().min(1) });
const SessionParams = z.object({ id: z.string().min(1) });

const SettingsBody = z.object({
  enabled: z.boolean(),
  storiesPerNight: z.number().int().min(1).max(20).nullable(),
  minutesPerNight: z.number().int().min(5).max(240).nullable(),
  sleepTimerMinutes: z.number().int().min(1).max(120).nullable(),
  readAloud: z.boolean(),
  timeZone: z.string().min(1).max(64).refine(isValidTimeZone, { message: "Unknown time zone" }),
  nightStartsHour: z.number().int().min(0).max(23),
}) satisfies z.ZodType<StorytellerSettings>;

const StartBody = z.object({ bookId: z.string().min(1), mode: z.enum(STORYTELLER_MODES) });
const BeatBody = z.object({ playing: z.boolean() });
const EndBody = z.object({ playing: z.boolean().default(false), completed: z.boolean().default(false) });
const HistoryQuery = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) });

export async function storytellerRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  /** The kid the URL names, if the viewer may see them: themselves, a linked parent, an admin. */
  function viewKid(viewer: Reader, kidParam: string): Reader {
    const u = loadVisibleUser(db, viewer, kidParam === "me" ? viewer.userId : kidParam);
    if (u.role !== "kid") throw httpError(404, "Not found");
    return toReader(u);
  }

  function requireKid(viewer: Reader): Reader {
    if (viewer.role !== "kid") throw httpError(403, "Storyteller stories are played from a kid's profile");
    return viewer;
  }

  /** The kid's storyteller shelf, in the order the parent added the books, at most 9. */
  function stories(kid: Reader, viewer: Reader) {
    const rows = db
      .select({
        id: books.id,
        title: books.title,
        coverPath: books.coverPath,
        rating: books.rating,
        absItemId: books.absItemId,
      })
      .from(kidShelf)
      .innerJoin(books, eq(books.id, kidShelf.bookId))
      .where(and(eq(kidShelf.kidId, kid.userId), eq(kidShelf.storyteller, true), visibleBooksWhere(kid), visibleBooksWhere(viewer)))
      .orderBy(asc(kidShelf.createdAt), asc(books.sortTitle))
      .limit(STORYTELLER_MAX_COVERS)
      .all();
    const ids = rows.map((r) => r.id);
    const readable = new Set(
      ids.length
        ? db
            .select({ bookId: bookFiles.bookId })
            .from(bookFiles)
            .where(and(inArray(bookFiles.bookId, ids), inArray(bookFiles.format, [...READ_ALOUD_FORMATS])))
            .all()
            .map((r) => r.bookId)
        : [],
    );
    const localAudio = bookIdsWithLocalAudio(db, ids); // ws/audio: local audiobooks count too
    return rows.map(({ absItemId, ...b }) => ({ ...b, hasAudio: absItemId != null || localAudio.has(b.id), canReadAloud: readable.has(b.id) }));
  }

  function loadSession(kid: Reader, id: string) {
    const s = db.select().from(storytellerSessions).where(eq(storytellerSessions.id, id)).get();
    if (!s || s.kidId !== kid.userId) throw httpError(404, "Not found");
    return s;
  }

  // ---------------------------------------------------------------- the storyteller screen

  app.get("/api/storyteller/kids/:kidId", async (req) => {
    const viewer = requireReader(req);
    const { kidId } = KidParams.parse(req.params);
    const kid = viewKid(viewer, kidId);
    const settings = getSettings(db, kid.userId);
    const list = stories(kid, viewer);
    return {
      kid: { id: kid.userId, displayName: kid.displayName },
      settings,
      canEdit: viewer.userId !== kid.userId && canManage(db, viewer, kidRow(kid)),
      tonight: tonight(db, kid.userId),
      beatIntervalMs: BEAT_INTERVAL_MS,
      stories: settings.readAloud ? list : list.map((s) => ({ ...s, canReadAloud: false })),
    };
  });

  app.put("/api/storyteller/kids/:kidId/settings", async (req) => {
    const viewer = requireReader(req);
    const { kidId } = KidParams.parse(req.params);
    const kid = viewKid(viewer, kidId);
    // Kids never change their own limits; parents only their linked kids; admins anyone.
    if (viewer.userId === kid.userId || !canManage(db, viewer, kidRow(kid))) {
      throw httpError(403, "Only a parent can change storyteller settings");
    }
    const body = SettingsBody.parse(req.body);
    return { settings: saveSettings(db, kid.userId, body, viewer.userId), tonight: tonight(db, kid.userId) };
  });

  /** Parent view: what was played lately. Book titles go through the content lock for the viewer. */
  app.get("/api/storyteller/kids/:kidId/history", async (req) => {
    const viewer = requireReader(req);
    const { kidId } = KidParams.parse(req.params);
    const { days } = HistoryQuery.parse(req.query);
    const kid = viewKid(viewer, kidId);
    const sessions = recentSessions(db, kid.userId, Date.now() - days * 86_400_000);
    const ids = [...new Set(sessions.map((s) => s.bookId))];
    const titles = new Map(
      ids.length
        ? db
            .select({ id: books.id, title: books.title })
            .from(books)
            .where(and(inArray(books.id, ids), visibleBooksWhere(viewer)))
            .all()
            .map((b) => [b.id, b.title])
        : [],
    );
    return {
      items: sessions
        .filter((s) => titles.has(s.bookId))
        .map((s) => ({
          id: s.id,
          bookId: s.bookId,
          title: titles.get(s.bookId),
          mode: s.mode,
          night: s.night,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          completed: s.completed,
          listenedSeconds: Math.round(s.listenedMs / 1000),
        })),
    };
  });

  // ---------------------------------------------------------------- playing (kid only)

  app.post("/api/storyteller/stories", async (req, reply) => {
    const kid = requireKid(requireReader(req));
    const { bookId, mode } = StartBody.parse(req.body);
    const book = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(kid, book);
    const onShelf = db
      .select({ storyteller: kidShelf.storyteller })
      .from(kidShelf)
      .where(and(eq(kidShelf.kidId, kid.userId), eq(kidShelf.bookId, bookId)))
      .get();
    if (!onShelf?.storyteller) throw httpError(404, "Not found");
    if (mode === "audio" && !hasAudio(db, book)) throw httpError(422, "This story has no audiobook");
    if (mode === "read_aloud") {
      if (!getSettings(db, kid.userId).readAloud) throw httpError(422, "Read-aloud is off for this profile");
      const file = db
        .select({ id: bookFiles.id })
        .from(bookFiles)
        .where(and(eq(bookFiles.bookId, bookId), inArray(bookFiles.format, [...READ_ALOUD_FORMATS])))
        .get();
      if (!file) throw httpError(422, "This story has no book file to read aloud");
    }

    const result = startStory(db, kid.userId, bookId, mode);
    if (!result.ok) return reply.code(409).send({ error: "That's all the stories for tonight", goodnight: true, tonight: result.tonight });
    return reply.code(201).send({
      session: { id: result.session.id, bookId, mode, startedAt: result.session.startedAt },
      tonight: result.tonight,
      beatIntervalMs: BEAT_INTERVAL_MS,
    });
  });

  app.post("/api/storyteller/sessions/:id/beat", async (req) => {
    const kid = requireKid(requireReader(req));
    const { id } = SessionParams.parse(req.params);
    const { playing } = BeatBody.parse(req.body);
    return beat(db, loadSession(kid, id), playing);
  });

  app.post("/api/storyteller/sessions/:id/end", async (req) => {
    const kid = requireKid(requireReader(req));
    const { id } = SessionParams.parse(req.params);
    const { playing, completed } = EndBody.parse(req.body ?? {});
    return { tonight: endStory(db, loadSession(kid, id), playing, completed) };
  });
}

/** canManage only needs these fields of the target user. */
function kidRow(kid: Reader) {
  return { id: kid.userId, householdId: kid.householdId, role: kid.role } as Parameters<typeof canManage>[2];
}
