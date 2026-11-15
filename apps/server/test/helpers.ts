import type { FastifyInstance } from "fastify";
import { buildApp, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/client.js";
import { books, families, households, parentLinks, userIdentities, users } from "../src/db/schema.js";

export const KEY = Buffer.alloc(32, 7);

export interface Family {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
  /** Admin, Dad, Aunt and Emma are the "Home" family; Leo is in "Cousins" (no parent there yet). */
  ids: { admin: string; parent: string; adult: string; kid: string; otherKid: string; home: string; cousins: string };
  book: (title: string, rating: (typeof books.$inferInsert)["rating"], extra?: Partial<typeof books.$inferInsert>) => string;
  as: (who: "admin" | "parent" | "adult" | "kid") => { "remote-email": string };
}

export async function family(deps: AppDeps = {}, env: Record<string, string> = {}): Promise<Family> {
  const { db, close } = openDb(":memory:");
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const kidYear = new Date().getUTCFullYear() - 8;
  const homeFamily = db.insert(families).values({ householdId: home!.id, name: "Home" }).returning().get().id;
  const cousins = db.insert(families).values({ householdId: home!.id, name: "Cousins" }).returning().get().id;
  const mk = (displayName: string, role: "admin" | "parent" | "adult" | "kid", email?: string, familyId = homeFamily) => {
    const [u] = db
      .insert(users)
      .values({ householdId: home!.id, familyId, displayName, role, birthYear: role === "kid" ? kidYear : null })
      .returning()
      .all();
    if (email) db.insert(userIdentities).values({ userId: u!.id, provider: "tinyauth", subject: email }).run();
    return u!.id;
  };
  const ids = {
    admin: mk("Admin", "admin", "admin@example.com"),
    parent: mk("Dad", "parent", "dad@example.com"),
    adult: mk("Aunt", "adult", "aunt@example.com"),
    kid: mk("Emma", "kid", "emma@example.com"),
    otherKid: mk("Leo", "kid", undefined, cousins),
    home: homeFamily,
    cousins,
  };
  db.insert(parentLinks).values({ parentId: ids.parent, kidId: ids.kid }).run();

  const config = loadConfig({ TRUSTED_PROXIES: "127.0.0.1", LOG_LEVEL: "error", ...env } as NodeJS.ProcessEnv);
  const app = await buildApp(config, db, { ...deps, integrations: { secretKey: KEY, ...deps.integrations } });
  return {
    app,
    db,
    ids,
    close: async () => {
      await app.close();
      close();
    },
    book: (title, rating, extra = {}) =>
      db
        .insert(books)
        .values({ title, sortTitle: title.toLowerCase(), rating, approved: true, ...extra })
        .returning()
        .all()[0]!.id,
    as: (who) => ({
      "remote-email": { admin: "admin@example.com", parent: "dad@example.com", adult: "aunt@example.com", kid: "emma@example.com" }[who],
    }),
  };
}
