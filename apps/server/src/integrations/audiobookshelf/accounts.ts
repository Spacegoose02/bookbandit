/**
 * Each person's own Audiobookshelf account, for importing their progress and writing their
 * listening position back. Admin-only, like every integration setting (kids can't link or
 * unlink their own account either).
 *
 *   GET    /api/admin/audiobookshelf/accounts            every person and their ABS link
 *   PUT    /api/admin/audiobookshelf/accounts/:userId    { token?, writeBack? }
 *   DELETE /api/admin/audiobookshelf/accounts/:userId
 *   POST   /api/admin/audiobookshelf/import              { userIds?, dryRun? }
 *
 * The token is an ABS API key made for that ABS user (ABS → Settings → API Keys → "Act as user"),
 * or the user's legacy API token. It is checked against /api/me, sealed, and never returned.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "../../auth/plugin.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { absAccounts } from "../../audio/schema.js";
import type { SecretBox } from "../secrets.js";
import { AbsError } from "./client.js";
import type { AbsSync, ImportReport } from "./sync.js";

const UserParams = z.object({ userId: z.string().min(1).max(64) });
const AccountBody = z
  .object({ token: z.string().trim().min(8).max(4096).optional(), writeBack: z.boolean().optional() })
  .refine((b) => b.token != null || b.writeBack != null, "nothing to change");
const ImportBody = z
  .object({ userIds: z.array(z.string().min(1).max(64)).max(100).optional(), dryRun: z.boolean().default(false) })
  .default({});

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export async function absAccountRoutes(app: FastifyInstance, opts: { db: Db; box: SecretBox; sync: AbsSync }) {
  const { db, box, sync } = opts;

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err instanceof AbsError) {
      req.log.warn({ err }, "audiobookshelf request failed");
      return reply.code(502).send({ error: "Audiobookshelf request failed" });
    }
    return reply.send(err);
  });

  function personInHousehold(householdId: string, userId: string) {
    const u = db
      .select({ id: users.id, displayName: users.displayName, role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.householdId, householdId)))
      .get();
    if (!u) throw httpError(404, "Not found");
    return u;
  }

  app.get("/api/admin/audiobookshelf/accounts", async (req) => {
    const admin = requireAdmin(req);
    const people = db
      .select({ id: users.id, displayName: users.displayName, role: users.role })
      .from(users)
      .where(and(eq(users.householdId, admin.householdId), eq(users.disabled, false)))
      .orderBy(asc(users.displayName))
      .all();
    const accounts = new Map(db.select().from(absAccounts).all().map((a) => [a.userId, a]));
    return {
      items: people.map((p) => {
        const a = accounts.get(p.id);
        return {
          userId: p.id,
          displayName: p.displayName,
          role: p.role,
          account: a
            ? {
                absUsername: a.absUsername,
                writeBack: a.writeBack,
                lastImportAt: a.lastImportAt,
                lastPushAt: a.lastPushAt,
                lastError: a.lastError,
              }
            : null,
        };
      }),
    };
  });

  app.put("/api/admin/audiobookshelf/accounts/:userId", async (req) => {
    const admin = requireAdmin(req);
    const { userId } = UserParams.parse(req.params);
    const body = AccountBody.parse(req.body);
    personInHousehold(admin.householdId, userId);
    const existing = db.select().from(absAccounts).where(eq(absAccounts.userId, userId)).get();
    const now = Date.now();

    if (body.token) {
      let me: { id: string; username: string };
      try {
        me = await sync.whoAmI(body.token);
      } catch (err) {
        if (err instanceof AbsError) throw httpError(err.status === 401 || err.status === 403 ? 422 : 502, "Audiobookshelf didn't accept that key");
        throw err;
      }
      const values = {
        userId,
        absUserId: me.id,
        absUsername: me.username,
        tokenSealed: box.seal(body.token),
        writeBack: body.writeBack ?? existing?.writeBack ?? true,
        lastError: null,
        updatedAt: now,
      };
      db.insert(absAccounts).values(values).onConflictDoUpdate({ target: absAccounts.userId, set: values }).run();
    } else {
      if (!existing) throw httpError(400, "Paste this person's Audiobookshelf API key first");
      db.update(absAccounts).set({ writeBack: body.writeBack!, updatedAt: now }).where(eq(absAccounts.userId, userId)).run();
    }
    const a = db.select().from(absAccounts).where(eq(absAccounts.userId, userId)).get()!;
    return { userId, absUsername: a.absUsername, writeBack: a.writeBack, lastImportAt: a.lastImportAt, lastPushAt: a.lastPushAt, lastError: a.lastError };
  });

  app.delete("/api/admin/audiobookshelf/accounts/:userId", async (req, reply) => {
    const admin = requireAdmin(req);
    const { userId } = UserParams.parse(req.params);
    personInHousehold(admin.householdId, userId);
    db.delete(absAccounts).where(eq(absAccounts.userId, userId)).run();
    return reply.code(204).send();
  });

  app.post("/api/admin/audiobookshelf/import", async (req) => {
    const admin = requireAdmin(req);
    const { userIds, dryRun } = ImportBody.parse(req.body ?? {});
    const linked = db.select({ userId: absAccounts.userId }).from(absAccounts).all().map((a) => a.userId);
    const targets = (userIds ?? linked).filter((id) => {
      try {
        personInHousehold(admin.householdId, id);
        return true;
      } catch {
        return false;
      }
    });
    const reports: ImportReport[] = [];
    const errors: { userId: string; error: string }[] = [];
    for (const userId of targets) {
      try {
        reports.push(await sync.importFor(userId, { dryRun }));
      } catch (err) {
        errors.push({ userId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { dryRun, reports, errors };
  });
}
