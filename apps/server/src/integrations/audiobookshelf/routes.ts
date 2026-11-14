/**
 * Audiobookshelf admin routes: configure the connection and link books to ABS items (by hand or
 * automatically). Playback and listening positions for readers live in src/audio/routes.ts,
 * which serves ABS and local audiobooks through the same API; each person's ABS account,
 * import and write-back are in accounts.ts and sync.ts.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "../../auth/plugin.js";
import { authors, bookAuthors, books } from "../../db/schema.js";
import { httpError, type IntegrationsContext } from "../context.js";
import {
  AbsSettingsInput,
  getAbsSettings,
  publicAbsSettings,
  saveAbsSettings,
  type AbsSettings,
} from "../settings.js";
import { AbsError, AudiobookshelfClient, type AbsItemSummary } from "./client.js";
import { matchBooks, type BookForMatch } from "./match.js";

const IdParams = z.object({ id: z.string().min(1) });

const LinkBody = z.object({ absItemId: z.string().min(1) });
const AutoLinkBody = z.object({ dryRun: z.boolean().default(false) });
const ItemsQuery = z.object({ q: z.string().optional(), unlinked: z.coerce.boolean().optional() });

export async function audiobookshelfRoutes(app: FastifyInstance, ctx: IntegrationsContext) {
  const { db, box } = ctx;

  function settingsOrNull(): AbsSettings | null {
    return getAbsSettings(db, box);
  }

  function client(): AudiobookshelfClient {
    const s = settingsOrNull();
    if (!s || !s.enabled) throw httpError(503, "Audiobookshelf is not connected");
    return new AudiobookshelfClient(s.url, s.token, ctx.fetchImpl);
  }

  async function absItems(c: AudiobookshelfClient, s: AbsSettings): Promise<AbsItemSummary[]> {
    const libs = s.libraryIds.length
      ? s.libraryIds
      : (await c.libraries()).filter((l) => l.mediaType === "book").map((l) => l.id);
    const lists = await Promise.all(libs.map((id) => c.libraryItems(id)));
    return lists.flat();
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof AbsError) {
      req.log.warn({ err }, "audiobookshelf request failed");
      return reply.code(err.status === 404 ? 404 : 502).send({ error: "Audiobookshelf request failed" });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  // ---------------------------------------------------------------- admins

  app.get("/api/admin/integrations/audiobookshelf", async (req) => {
    requireAdmin(req);
    return publicAbsSettings(settingsOrNull());
  });

  app.put("/api/admin/integrations/audiobookshelf", async (req) => {
    requireAdmin(req);
    const input = AbsSettingsInput.parse(req.body);
    const saved = saveAbsSettings(db, box, input);
    return publicAbsSettings(saved);
  });

  app.post("/api/admin/integrations/audiobookshelf/test", async (req) => {
    requireAdmin(req);
    const c = client();
    const me = await c.ping();
    const libraries = await c.libraries();
    return { ok: true, username: me.username, libraries };
  });

  app.get("/api/admin/audiobookshelf/items", async (req) => {
    requireAdmin(req);
    const q = ItemsQuery.parse(req.query);
    const s = settingsOrNull();
    if (!s?.enabled) throw httpError(503, "Audiobookshelf is not connected");
    let items = await absItems(client(), s);
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter((i) => `${i.title} ${i.authorName ?? ""}`.toLowerCase().includes(needle));
    }
    const ids = items.map((i) => i.id);
    const linked = new Map(
      ids.length
        ? db
            .select({ id: books.id, absItemId: books.absItemId })
            .from(books)
            .where(inArray(books.absItemId, ids))
            .all()
            .map((b) => [b.absItemId!, b.id])
        : [],
    );
    const out = items.map((i) => ({ ...i, linkedBookId: linked.get(i.id) ?? null }));
    return { items: q.unlinked ? out.filter((i) => !i.linkedBookId) : out };
  });

  app.put("/api/admin/books/:id/audiobookshelf", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const { absItemId } = LinkBody.parse(req.body);
    const book = db.select({ id: books.id }).from(books).where(eq(books.id, id)).get();
    if (!book) throw httpError(404, "Not found");
    const other = db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(and(eq(books.absItemId, absItemId), ne(books.id, id)))
      .get();
    if (other) throw httpError(409, `That audiobook is already linked to "${other.title}"`);
    const item = await client().item(absItemId); // 404 from ABS → 404 here
    db.update(books).set({ absItemId, updatedAt: Date.now() }).where(eq(books.id, id)).run();
    return { bookId: id, absItemId, title: item.title, duration: item.duration };
  });

  app.delete("/api/admin/books/:id/audiobookshelf", async (req, reply) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    db.update(books).set({ absItemId: null, updatedAt: Date.now() }).where(eq(books.id, id)).run();
    return reply.code(204).send();
  });

  app.post("/api/admin/audiobookshelf/auto-link", async (req) => {
    requireAdmin(req);
    const { dryRun } = AutoLinkBody.parse(req.body ?? {});
    const s = settingsOrNull();
    if (!s?.enabled) throw httpError(503, "Audiobookshelf is not connected");
    const items = await absItems(client(), s);

    const alreadyLinked = new Set(
      db
        .select({ absItemId: books.absItemId })
        .from(books)
        .all()
        .map((b) => b.absItemId)
        .filter(Boolean),
    );
    const free = items.filter((i) => !alreadyLinked.has(i.id));
    const unlinked = db
      .select({ id: books.id, title: books.title, isbn13: books.isbn13, kindleAsin: books.kindleAsin })
      .from(books)
      .where(isNull(books.absItemId))
      .all();
    const authorRows = unlinked.length
      ? db
          .select({ bookId: bookAuthors.bookId, name: authors.name })
          .from(bookAuthors)
          .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
          .where(inArray(bookAuthors.bookId, unlinked.map((b) => b.id)))
          .all()
      : [];
    const byBook = new Map<string, string[]>();
    for (const r of authorRows) byBook.set(r.bookId, [...(byBook.get(r.bookId) ?? []), r.name]);
    const candidates: BookForMatch[] = unlinked.map((b) => ({ ...b, authors: byBook.get(b.id) ?? [] }));

    const matches = matchBooks(candidates, free);
    if (!dryRun && matches.length) {
      const now = Date.now();
      db.transaction((tx) => {
        for (const m of matches) {
          tx.update(books).set({ absItemId: m.absItemId, updatedAt: now }).where(and(eq(books.id, m.bookId), isNull(books.absItemId))).run();
        }
      });
    }
    const titles = new Map(unlinked.map((b) => [b.id, b.title]));
    const itemTitles = new Map(free.map((i) => [i.id, i.title]));
    return {
      dryRun,
      linked: matches.map((m) => ({ ...m, bookTitle: titles.get(m.bookId), absTitle: itemTitles.get(m.absItemId) })),
      unmatchedBooks: unlinked.length - matches.length,
      unmatchedAudiobooks: free.length - matches.length,
    };
  });
}
