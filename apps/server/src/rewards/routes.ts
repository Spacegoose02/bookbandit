/**
 * Rewards API: reading goals, badges, the sticker book and reading bedtime. See README.md here.
 *
 * - Kids read their own summary and mark celebrations as seen; that's all they can change.
 * - Linked parents and admins read a kid's summary and set goals and bedtime (CLAUDE.md rule 2).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bedtimeStatus, GOAL_LIMITS, isValidTimeZone, type BedtimeSettings, type ReadingGoal } from "@bookbandit/shared";
import { httpError, requireReader } from "../auth/plugin.js";
import { canManage, loadVisibleUser, type UserRow } from "../auth/permissions.js";
import { toReader, type Reader } from "../auth/reader.js";
import type { Db } from "../db/client.js";
import { getBedtime, getGoal, markSeen, saveBedtime, saveGoal, summary } from "./service.js";

const UserParams = z.object({ userId: z.string().min(1).max(64) });
const KidParams = z.object({ kidId: z.string().min(1).max(64) });
const TimeZone = z.string().min(1).max(64).refine(isValidTimeZone, { message: "Unknown time zone" });

const GoalBody = z.object({
  minutesPerDay: z.number().int().min(GOAL_LIMITS.minutesPerDay.min).max(GOAL_LIMITS.minutesPerDay.max).nullable(),
  booksPerMonth: z.number().int().min(GOAL_LIMITS.booksPerMonth.min).max(GOAL_LIMITS.booksPerMonth.max).nullable(),
  timeZone: TimeZone,
}) satisfies z.ZodType<ReadingGoal>;

/** Bedtime starts in the evening (noon to midnight) and ends in the morning (midnight to noon). */
const Evening = z.number().int().min(12 * 60).max(24 * 60 - 1);
const Morning = z.number().int().min(0).max(12 * 60);
const BedtimeBody = z.object({
  enabled: z.boolean(),
  startMinute: Evening,
  endMinute: Morning,
  weekendStartMinute: Evening.nullable(),
  timeZone: TimeZone,
}) satisfies z.ZodType<BedtimeSettings>;

const SeenBody = z.object({ ids: z.array(z.string().min(1).max(64)).max(500) });

export async function rewardsRoutes(app: FastifyInstance, opts: { db: Db; now?: () => number }) {
  const { db } = opts;
  const now = opts.now ?? Date.now;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  /** The kid the URL names, if the viewer may see them (themselves, a linked parent, an admin). */
  function viewKid(viewer: Reader, id: string): UserRow {
    const u = loadVisibleUser(db, viewer, id === "me" ? viewer.userId : id);
    if (u.role !== "kid") throw httpError(404, "Not found");
    return u;
  }

  /** Kids never change their own goals or bedtime; parents only their linked kids; admins anyone. */
  function manageKid(viewer: Reader, id: string): UserRow {
    const u = viewKid(viewer, id);
    if (u.id === viewer.userId || !canManage(db, viewer, u)) throw httpError(403, "Only a parent can change this");
    return u;
  }

  app.get("/api/rewards/:userId", async (req) => {
    const viewer = requireReader(req);
    const { userId } = UserParams.parse(req.params);
    const u = loadVisibleUser(db, viewer, userId === "me" ? viewer.userId : userId);
    return summary(db, toReader(u), viewer, now());
  });

  app.post("/api/rewards/me/seen", async (req) => {
    const viewer = requireReader(req);
    const { ids } = SeenBody.parse(req.body);
    return { marked: markSeen(db, viewer.userId, ids, now()) };
  });

  /** Small and cheap, so the kid app can check it every minute. */
  app.get("/api/rewards/me/bedtime", async (req) => {
    const viewer = requireReader(req);
    return bedtimeStatus(getBedtime(db, viewer.userId), now());
  });

  app.get("/api/rewards/kids/:kidId/settings", async (req) => {
    const viewer = requireReader(req);
    const { kidId } = KidParams.parse(req.params);
    const kid = viewKid(viewer, kidId);
    const goal = getGoal(db, kid.id);
    const bedtime = getBedtime(db, kid.id);
    return {
      kid: { id: kid.id, displayName: kid.displayName },
      canEdit: kid.id !== viewer.userId && canManage(db, viewer, kid),
      goal: goal && { minutesPerDay: goal.minutesPerDay, booksPerMonth: goal.booksPerMonth, timeZone: goal.timeZone },
      bedtime,
      bedtimeNow: bedtimeStatus(bedtime, now()),
    };
  });

  app.put("/api/rewards/kids/:kidId/goal", async (req) => {
    const viewer = requireReader(req);
    const { kidId } = KidParams.parse(req.params);
    const kid = manageKid(viewer, kidId);
    const body = GoalBody.parse(req.body);
    return { goal: saveGoal(db, kid.id, body, viewer.userId, now()) };
  });

  app.put("/api/rewards/kids/:kidId/bedtime", async (req) => {
    const viewer = requireReader(req);
    const { kidId } = KidParams.parse(req.params);
    const kid = manageKid(viewer, kidId);
    const body = BedtimeBody.parse(req.body);
    const bedtime = saveBedtime(db, kid.id, body, viewer.userId, now());
    return { bedtime, bedtimeNow: bedtimeStatus(bedtime, now()) };
  });
}
