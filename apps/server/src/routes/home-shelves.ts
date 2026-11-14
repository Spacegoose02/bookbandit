/**
 * GET /api/shelves: the rows on the home screen, each with its first books.
 * Every shelf's `id` also works as `?shelf=` on /api/books to page through it.
 * Shelves with no books the reader can see are left out.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, isNull, max, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { books, bookSeries, bookTags, collectionBooks, collections, series, tags } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { listBooks, type BookSummary } from "../catalog/list.js";

const Query = z.object({
  perShelf: z.coerce.number().int().min(1).max(50).default(20),
  maxSeries: z.coerce.number().int().min(0).max(20).default(5),
});

type ShelfKind = "continue" | "kid" | "recent" | "series" | "collection" | "tag";
interface Shelf {
  id: string;
  name: string;
  kind: ShelfKind;
  total: number;
  books: BookSummary[];
}

export async function homeShelfRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  function shelf(reader: Reader, id: string, name: string, kind: ShelfKind, limit: number): Shelf | null {
    const sort = kind === "recent" ? "added" : kind === "series" ? "year" : undefined;
    const { items, total } = listBooks(db, reader, { shelf: id, sort, limit, offset: 0 });
    return items.length ? { id, name, kind, total, books: items } : null;
  }

  app.get("/api/shelves", async (req) => {
    const reader = requireReader(req);
    const q = Query.parse(req.query);
    const visible = visibleBooksWhere(reader);
    const out: (Shelf | null)[] = [];

    out.push(shelf(reader, "continue", "Continue reading", "continue", q.perShelf));
    if (reader.isKid) out.push(shelf(reader, "kid", "My shelf", "kid", q.perShelf));
    out.push(shelf(reader, "recent", "Recently added", "recent", q.perShelf));

    // Section tags (Kids, Cookbooks, ...) that have visible books.
    const sectionTags = db
      .selectDistinct({ id: tags.id, name: tags.name })
      .from(tags)
      .innerJoin(bookTags, eq(bookTags.tagId, tags.id))
      .innerJoin(books, eq(books.id, bookTags.bookId))
      .where(and(eq(tags.kind, "section"), visible))
      .orderBy(asc(tags.name))
      .all();
    for (const t of sectionTags) out.push(shelf(reader, `tag:${t.id}`, t.name, "tag", q.perShelf));

    // Household collections shared with everyone or owned by this reader.
    const cols = db
      .select({ id: collections.id, name: collections.name })
      .from(collections)
      .where(
        and(
          eq(collections.householdId, reader.householdId),
          or(isNull(collections.ownerId), eq(collections.ownerId, reader.userId)),
        ),
      )
      .orderBy(asc(collections.name))
      .all();
    for (const c of cols) {
      const hasAny = db
        .select({ id: collectionBooks.bookId })
        .from(collectionBooks)
        .where(eq(collectionBooks.collectionId, c.id))
        .limit(1)
        .get();
      if (hasAny) out.push(shelf(reader, `collection:${c.id}`, c.name, "collection", q.perShelf));
    }

    // The series with the most recently added visible books.
    if (q.maxSeries > 0) {
      const recentSeries = db
        .select({ id: series.id, name: series.name, latest: max(books.addedAt) })
        .from(series)
        .innerJoin(bookSeries, eq(bookSeries.seriesId, series.id))
        .innerJoin(books, eq(books.id, bookSeries.bookId))
        .where(visible)
        .groupBy(series.id)
        .orderBy(desc(max(books.addedAt)))
        .limit(q.maxSeries)
        .all();
      for (const s of recentSeries) out.push(shelf(reader, `series:${s.id}`, s.name, "series", q.perShelf));
    }

    return { items: out.filter((s): s is Shelf => s !== null) };
  });
}
