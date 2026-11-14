/**
 * Family apps (Den Duty chores, Nighttime Ninja kitchen). Registered from app.ts.
 *
 * - Admins link the apps and match BookBandit kids to Den Duty kids and habits (`/api/admin/family-apps…`).
 * - A reporter sends kids' reading minutes and finished books to Den Duty every few minutes.
 * - Grown-ups send a recipe from Cook mode to Nighttime Ninja (`POST /api/family-apps/kitchen/recipes`).
 *
 * BookBandit always calls out with the other app's token; nothing here accepts tokens from them.
 * See README.md in this folder.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books, users } from "../db/schema.js";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import { useAuthErrors } from "../auth/errors.js";
import type { SecretBox } from "../integrations/secrets.js";
import type { FetchLike } from "../metadata/providers/http.js";
import { loadVisibleBook } from "../routes/progress.js";
import { AppCallError, makeCaller } from "./client.js";
import { buildReport, type DenHabit, type DenHome, type DenKid, type ReportKid, type ReportResult } from "./den-duty.js";
import { recipeText, SendRecipeInput, sortBlocks, type NinjaRecipe } from "./kitchen.js";
import {
  DenDutyInput,
  KitchenInput,
  linkedHouseholds,
  nextToken,
  publicSettings,
  PublicUrlInput,
  readStored,
  writeStored,
  type DenDutyLink,
} from "./settings.js";

export interface FamilyAppsOptions {
  db: Db;
  box: SecretBox;
  fetchImpl?: FetchLike;
  /** How often the reporter runs. Default 5 minutes; 0 turns the timer off (tests call `reportNow`). */
  reportEveryMs?: number;
}

export interface LastReport {
  at: number;
  ok: boolean;
  error?: string;
  sent: number;
  result?: ReportResult;
}

declare module "fastify" {
  interface FastifyInstance {
    familyApps: { reportAll(): Promise<void>; reportHousehold(householdId: string, force?: boolean): Promise<LastReport | null> };
  }
}

const DEFAULT_EVERY = 5 * 60_000;

export const familyAppsPlugin = fp(async (app: FastifyInstance, opts: FamilyAppsOptions) => {
  const { db, box } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const denCall = makeCaller(fetchImpl, box, "Den Duty");
  const kitchenCall = makeCaller(fetchImpl, box, "Nighttime Ninja");

  /** What was last sent per household:kid:date, so unchanged days aren't sent again. */
  const sentSig = new Map<string, string>();
  const last = new Map<string, LastReport>();
  const v1 = (link: DenDutyLink) => `/api/v1/homes/${encodeURIComponent(link.homeId)}`;

  async function reportHousehold(householdId: string, force = false): Promise<LastReport | null> {
    const link = readStored(db, householdId).denDuty;
    if (!link?.token || !Object.keys(link.kids).length) return null;
    let report: ReportKid[] = [];
    try {
      const home = await denCall<DenHome>(link, "GET", v1(link));
      report = buildReport(db, householdId, link, home);
      const sig = (k: ReportKid) => `${k.minutes}|${k.finished.map((b) => b.id).join(",")}`;
      const key = (k: ReportKid) => `${householdId}:${k.kidId}:${k.habitId}:${k.date}`;
      const changed = force ? report : report.filter((k) => sentSig.get(key(k)) !== sig(k));
      if (!changed.length) return last.get(householdId) ?? null;
      const result = await denCall<ReportResult>(link, "POST", `${v1(link)}/reading/report`, { kids: changed });
      for (const k of changed) sentSig.set(key(k), sig(k));
      const done: LastReport = { at: Date.now(), ok: true, sent: changed.length, result };
      last.set(householdId, done);
      return done;
    } catch (e) {
      const failed: LastReport = { at: Date.now(), ok: false, sent: 0, error: e instanceof Error ? e.message : String(e) };
      last.set(householdId, failed);
      if (!(e instanceof AppCallError)) app.log.warn({ err: e }, "family-apps: Den Duty report failed");
      return failed;
    }
  }

  async function reportAll(): Promise<void> {
    for (const { householdId } of linkedHouseholds(db)) await reportHousehold(householdId);
  }

  app.decorate("familyApps", { reportAll, reportHousehold });

  const every = opts.reportEveryMs ?? DEFAULT_EVERY;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  if (every > 0) {
    app.addHook("onListen", async () => {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void reportAll().finally(() => (running = false));
      }, every);
      timer.unref();
    });
    app.addHook("onClose", async () => {
      if (timer) clearInterval(timer);
    });
  }

  await app.register(async (r) => {
    useAuthErrors(r);
    familyRoutes(r);
  });

  function householdKids(householdId: string) {
    return db
      .select({ id: users.id, displayName: users.displayName, avatar: users.avatar })
      .from(users)
      .where(and(eq(users.householdId, householdId), eq(users.role, "kid"), eq(users.disabled, false)))
      .all();
  }

  /** BookBandit's own address for links back: the admin's setting, else the address the browser used. */
  function selfUrl(req: FastifyRequest, stored: string | undefined): string {
    if (stored) return stored;
    const origin = req.headers.origin;
    if (typeof origin === "string" && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, "");
    return `${req.protocol}://${req.host}`;
  }

  function wrap(e: unknown): never {
    if (e instanceof AppCallError) throw httpError(502, e.message);
    throw e;
  }

  function familyRoutes(r: FastifyInstance) {
    // ---- Admin: links -------------------------------------------------------------------------
    r.get("/api/admin/family-apps", async (req) => {
      const admin = requireAdmin(req);
      const s = readStored(db, admin.householdId);
      return { ...publicSettings(s), kids: householdKids(admin.householdId), lastReport: last.get(admin.householdId) ?? null };
    });

    r.put("/api/admin/family-apps/den-duty", async (req) => {
      const admin = requireAdmin(req);
      const body = DenDutyInput.parse(req.body);
      const s = readStored(db, admin.householdId);
      const token = nextToken(box, body.token, s.denDuty?.token);
      if (!token) throw httpError(400, "Paste a Den Duty control token");
      const mine = new Set(householdKids(admin.householdId).map((k) => k.id));
      const kids: DenDutyLink["kids"] = {};
      for (const k of body.kids) {
        if (!mine.has(k.userId)) throw httpError(400, "That kid isn't in this household");
        kids[k.userId] = { kidId: k.kidId, habitId: k.habitId };
      }
      writeStored(db, admin.householdId, { ...s, denDuty: { url: body.url, homeId: body.homeId, token, enabled: body.enabled, kids } });
      return publicSettings(readStored(db, admin.householdId));
    });

    r.delete("/api/admin/family-apps/den-duty", async (req) => {
      const admin = requireAdmin(req);
      const { denDuty: _gone, ...rest } = readStored(db, admin.householdId);
      writeStored(db, admin.householdId, rest);
      last.delete(admin.householdId);
      return publicSettings(rest);
    });

    /** Den Duty's kids and each kid's practice habits, for matching kids in the settings card. */
    r.get("/api/admin/family-apps/den-duty/kids", async (req) => {
      const admin = requireAdmin(req);
      const link = readStored(db, admin.householdId).denDuty;
      if (!link?.token) throw httpError(409, "Link Den Duty first");
      try {
        const home = await denCall<DenHome>(link, "GET", v1(link));
        const kids = await denCall<DenKid[]>(link, "GET", `${v1(link)}/kids`);
        let habitsMissing = false;
        const withHabits = [];
        for (const k of kids.slice(0, 50)) {
          let habits: DenHabit[] = [];
          try {
            habits = await denCall<DenHabit[]>(link, "GET", `${v1(link)}/kids/${encodeURIComponent(k.id)}/habits`);
          } catch (e) {
            if (e instanceof AppCallError && e.status === 404) habitsMissing = true;
            else throw e;
          }
          withHabits.push({
            id: k.id,
            name: k.name,
            avatar: k.avatar ?? null,
            color: k.color ?? null,
            habits: habits.map((h) => ({ id: h.id, title: h.title, icon: h.icon, minutes: h.minutes })),
          });
        }
        return { home: { name: home.name, timezone: home.timezone, today: home.today }, kids: withHabits, habitsMissing };
      } catch (e) {
        wrap(e);
      }
    });

    r.post("/api/admin/family-apps/den-duty/report", async (req) => {
      const admin = requireAdmin(req);
      const link = readStored(db, admin.householdId).denDuty;
      if (!link?.token) throw httpError(409, "Link Den Duty first");
      if (!Object.keys(link.kids).length) throw httpError(409, "Match at least one kid first");
      const res = await reportHousehold(admin.householdId, true);
      if (res && !res.ok) throw httpError(502, res.error ?? "Den Duty didn't take the report");
      return res;
    });

    r.put("/api/admin/family-apps/kitchen", async (req) => {
      const admin = requireAdmin(req);
      const body = KitchenInput.parse(req.body);
      const s = readStored(db, admin.householdId);
      const token = nextToken(box, body.token, s.kitchen?.token);
      if (!token) throw httpError(400, "Paste a Nighttime Ninja home token");
      writeStored(db, admin.householdId, { ...s, kitchen: { url: body.url, homeId: body.homeId, token } });
      return publicSettings(readStored(db, admin.householdId));
    });

    r.delete("/api/admin/family-apps/kitchen", async (req) => {
      const admin = requireAdmin(req);
      const { kitchen: _gone, ...rest } = readStored(db, admin.householdId);
      writeStored(db, admin.householdId, rest);
      return publicSettings(rest);
    });

    /** Checks the Nighttime Ninja link with a cheap read. */
    r.post("/api/admin/family-apps/kitchen/check", async (req) => {
      const admin = requireAdmin(req);
      const link = readStored(db, admin.householdId).kitchen;
      if (!link?.token) throw httpError(409, "Link Nighttime Ninja first");
      try {
        await kitchenCall<unknown>(link, "GET", `/api/homes/${encodeURIComponent(link.homeId)}/ha/summary`);
        return { ok: true };
      } catch (e) {
        wrap(e);
      }
    });

    r.put("/api/admin/family-apps/public-url", async (req) => {
      const admin = requireAdmin(req);
      const body = PublicUrlInput.parse(req.body);
      const { publicUrl: _old, ...rest } = readStored(db, admin.householdId);
      writeStored(db, admin.householdId, body.publicUrl ? { ...rest, publicUrl: body.publicUrl } : rest);
      return publicSettings(readStored(db, admin.householdId));
    });

    // ---- Everyone: what's linked, and Send to kitchen ----------------------------------------
    r.get("/api/family-apps", async (req) => {
      const reader = requireReader(req);
      const s = readStored(db, reader.householdId);
      return {
        kitchen: !reader.isKid && !!s.kitchen?.token,
        // A kid whose reading minutes go to a Den Duty habit (the kid home says so).
        denDuty: reader.isKid && !!s.denDuty?.enabled && !!s.denDuty.kids[reader.userId],
      };
    });

    r.post("/api/family-apps/kitchen/recipes", async (req) => {
      const reader = requireReader(req);
      if (reader.isKid) throw httpError(403, "Ask a grown-up to send recipes to the kitchen");
      const body = SendRecipeInput.parse(req.body);
      loadVisibleBook(db, reader, body.bookId);
      const s = readStored(db, reader.householdId);
      const link = s.kitchen;
      if (!link?.token) throw httpError(409, "Nighttime Ninja isn't linked yet");
      const book = db.select({ title: books.title }).from(books).where(eq(books.id, body.bookId)).get()!;

      const sorted = sortBlocks(body.title, body.blocks);
      if (!sorted.ingredients.length && !sorted.steps.length) {
        throw httpError(422, "Barnaby couldn't find ingredients or steps on that page");
      }
      const back = `${selfUrl(req, s.publicUrl)}/cook/${encodeURIComponent(body.bookId)}${body.href ? `?at=${encodeURIComponent(body.href)}` : ""}`;
      const base = `/api/homes/${encodeURIComponent(link.homeId)}/recipes`;
      try {
        const parsed = await kitchenCall<{ recipes: NinjaRecipe[] }>(link, "POST", `${base}/import`, { text: recipeText(sorted) });
        const recipe = parsed.recipes?.[0];
        if (!recipe) throw httpError(422, "Nighttime Ninja couldn't read that recipe");
        const tags = [...new Set([...(recipe.tags ?? []), book.title.slice(0, 60)])];
        const saved = await kitchenCall<{ id: string }>(link, "POST", base, {
          ...recipe,
          title: sorted.title,
          sourceUrl: back,
          tags,
          noPublicShare: true,
        });
        return {
          id: saved.id,
          url: `${link.url}/recipes/${encodeURIComponent(saved.id)}`,
          title: sorted.title,
          ingredients: recipe.ingredients?.length ?? 0,
          steps: recipe.instructions?.length ?? 0,
        };
      } catch (e) {
        wrap(e);
      }
    });
  }
});
