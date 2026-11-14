/**
 * Metadata cleanup: the model looks at a book's title, authors, series and description and
 * suggests fixes (file-name junk in titles, "Last, First" author names, a series stuck in the
 * title, HTML or ads in the description). Each field is a separate suggestion an admin accepts
 * or dismisses; nothing changes without that.
 */
import { and, count, countDistinct, eq, inArray, notExists, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookFiles, books, bookSeries, series } from "../db/schema.js";
import { httpError } from "../auth/plugin.js";
import { setBookAuthors, setBookSeries } from "../library/store.js";
import { collapse, sortTitle } from "../metadata/text.js";
import type { AiContext } from "./context.js";
import type { BatchProgress } from "./rating.js";
import { bookFacts } from "./book-facts.js";
import { makeProvider } from "./providers/index.js";
import { aiMetadataChecks, aiMetadataSuggestions } from "./schema.js";
import { getAiSettings, providerFor } from "./settings.js";
import { tracked } from "./usage.js";

export const METADATA_FIELDS = ["title", "subtitle", "authors", "series", "description"] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];
export type SeriesValue = { name: string; position: number | null };
export type FieldValue = string | string[] | SeriesValue | null;

export function metadataPrompt(): string {
  return [
    "You tidy up a family library's book records. Suggest a fix only when a field is clearly wrong or messy:",
    '- title: file-name junk ("the_hobbit_v2 (retail)", "[epub]", "Book 1 - "), ALL CAPS, or a series stuck in the title ("Dune (Dune Chronicles #1)" -> "Dune").',
    '- subtitle: only when the title holds one ("Sapiens: A Brief History" -> title "Sapiens", subtitle "A Brief History of Humankind" only if shown).',
    '- authors: "Last, First" -> "First Last", initials spaced like "J. R. R. Tolkien", one name per person, no roles like "(Illustrator)".',
    "- series: when the title or file name shows it. Position is a number or null.",
    "- description: strip HTML, ads, review quotes and \"Praise for…\" blurbs. Keep the author's own words; never write a new description.",
    "Never invent facts you can't see in the record. Leave a field null to keep it.",
    'Reply with JSON only: {"title": string|null, "subtitle": string|null, "authors": [string]|null, "series": {"name": string, "position": number|null}|null, "description": string|null, "reason": "one short sentence"}',
  ].join("\n");
}

function clean(field: MetadataField, v: unknown): FieldValue | undefined {
  if (v == null) return undefined;
  if (field === "authors") {
    if (!Array.isArray(v)) return undefined;
    const names = v.map((x) => (typeof x === "string" ? collapse(x) : "")).filter(Boolean).slice(0, 10);
    return names.length ? names : undefined;
  }
  if (field === "series") {
    const o = v as { name?: unknown; position?: unknown };
    const name = typeof o.name === "string" ? collapse(o.name) : "";
    if (!name) return undefined;
    const p = Number(o.position);
    return { name: name.slice(0, 200), position: o.position == null || !Number.isFinite(p) ? null : p };
  }
  if (typeof v !== "string") return undefined;
  const s = field === "description" ? v.trim().slice(0, 8000) : collapse(v).slice(0, 500);
  return s || undefined;
}

export function parseMetadataReply(text: string): { fields: Partial<Record<MetadataField, FieldValue>>; reason: string } | null {
  const m = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m) as Record<string, unknown>;
  } catch {
    return null;
  }
  const fields: Partial<Record<MetadataField, FieldValue>> = {};
  for (const f of METADATA_FIELDS) {
    const v = clean(f, o[f]);
    if (v !== undefined) fields[f] = v;
  }
  return { fields, reason: typeof o.reason === "string" ? o.reason.slice(0, 300) : "" };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const unchecked = (db: Db) =>
  and(eq(books.kindleOnly, false), notExists(db.select({ x: sql`1` }).from(aiMetadataChecks).where(eq(aiMetadataChecks.bookId, books.id))));

/** Books nobody has checked yet, minus `skip` (earlier failures). Approved ones first, so the inbox doesn't crowd out the shelves. */
export function metadataCandidates(db: Db, limit: number, skip: string[] = []): string[] {
  return db
    .select({ id: books.id })
    .from(books)
    .where(and(unchecked(db), skip.length ? notInArray(books.id, skip) : undefined))
    .orderBy(sql`${books.approved} desc`, books.addedAt)
    .limit(limit)
    .all()
    .map((r) => r.id);
}

/** Where metadata cleanup stands over the whole library. `waiting` counts books with a fix to review. */
export function metadataProgress(db: Db, failedIds: string[]): BatchProgress & { fixes: number } {
  const n = (where: ReturnType<typeof and>) => db.select({ n: count() }).from(books).where(where).get()?.n ?? 0;
  const failed = failedIds.length ? n(and(unchecked(db), inArray(books.id, failedIds))) : 0;
  const pending = db
    .select({ books: countDistinct(aiMetadataSuggestions.bookId), fixes: count() })
    .from(aiMetadataSuggestions)
    .where(eq(aiMetadataSuggestions.status, "pending"))
    .get();
  return {
    total: n(eq(books.kindleOnly, false)),
    remaining: n(unchecked(db)) - failed,
    waiting: pending?.books ?? 0,
    fixes: pending?.fixes ?? 0,
    failed,
  };
}

/** Ask the model about one book and store a suggestion per field that would change. Returns how many. */
export async function checkMetadata(ctx: AiContext, bookId: string, userId: string | null): Promise<number> {
  const { db } = ctx;
  const config = providerFor(getAiSettings(db, ctx.box), "metadata");
  if (!config) throw httpError(503, "Pick a provider for metadata cleanup first");
  const provider = makeProvider(config, ctx.fetchImpl);
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) return 0;
  const f = bookFacts(db, [bookId]).get(bookId)!;
  const file = db.select({ relPath: bookFiles.relPath }).from(bookFiles).where(eq(bookFiles.bookId, bookId)).get();
  const current: Record<MetadataField, FieldValue> = {
    title: book.title,
    subtitle: book.subtitle,
    authors: f.authors.map((a) => a.name),
    series: f.series[0] ? { name: f.series[0].name, position: f.series[0].position } : null,
    description: book.description,
  };
  const record = [
    `Title: ${book.title}`,
    `Subtitle: ${book.subtitle ?? "(none)"}`,
    `Authors: ${f.authors.length ? f.authors.map((a) => a.name).join("; ") : "(none)"}`,
    `Series: ${current.series ? `${(current.series as SeriesValue).name}${(current.series as SeriesValue).position != null ? ` #${(current.series as SeriesValue).position}` : ""}` : "(none)"}`,
    book.publishedYear ? `Published: ${book.publishedYear}` : "",
    file ? `File: ${file.relPath}` : "",
    `Description: ${book.description ? book.description.slice(0, 4000) : "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const r = await tracked(ctx, provider, "metadata", userId, () =>
    provider.chat({ system: metadataPrompt(), messages: [{ role: "user", content: record }], maxTokens: 1500, temperature: 0, json: true }),
  );
  const parsed = parseMetadataReply(r.text);
  if (!parsed) throw new Error(`Couldn't read the model's suggestions for "${book.title}"`);
  const now = ctx.now().getTime();
  let n = 0;
  db.transaction((tx) => {
    for (const field of METADATA_FIELDS) {
      const suggested = parsed.fields[field];
      if (suggested === undefined || same(suggested, current[field])) continue;
      const old = tx
        .select()
        .from(aiMetadataSuggestions)
        .where(and(eq(aiMetadataSuggestions.bookId, bookId), eq(aiMetadataSuggestions.field, field)))
        .get();
      // An admin already said no to this exact change: don't ask again.
      if (old?.status === "dismissed" && same(old.suggested, suggested)) continue;
      const row = {
        bookId,
        field,
        current: current[field],
        suggested,
        reason: parsed.reason,
        providerId: config.id,
        model: r.model,
        status: "pending" as const,
        createdAt: now,
      };
      tx.insert(aiMetadataSuggestions)
        .values(row)
        .onConflictDoUpdate({ target: [aiMetadataSuggestions.bookId, aiMetadataSuggestions.field], set: row })
        .run();
      n++;
    }
    tx.insert(aiMetadataChecks).values({ bookId, checkedAt: now }).onConflictDoUpdate({ target: aiMetadataChecks.bookId, set: { checkedAt: now } }).run();
  });
  return n;
}

/** Apply one suggestion (or the admin's edited `value`) to the book. Admin-only at the route. */
export function acceptMetadata(db: Db, id: string, value?: unknown) {
  const s = db.select().from(aiMetadataSuggestions).where(eq(aiMetadataSuggestions.id, id)).get();
  if (!s) throw httpError(404, "Not found");
  const v = value === undefined ? (s.suggested as FieldValue) : clean(s.field, value);
  if (v === undefined || v === null) throw httpError(400, "Give a value for this field");
  const bookId = s.bookId;
  db.transaction((tx) => {
    const now = Date.now();
    switch (s.field) {
      case "title": {
        const title = collapse(v as string);
        tx.update(books).set({ title, sortTitle: sortTitle(title), updatedAt: now }).where(eq(books.id, bookId)).run();
        break;
      }
      case "subtitle":
        tx.update(books).set({ subtitle: v as string, updatedAt: now }).where(eq(books.id, bookId)).run();
        break;
      case "description":
        tx.update(books).set({ description: v as string, updatedAt: now }).where(eq(books.id, bookId)).run();
        break;
      case "authors":
        setBookAuthors(tx, bookId, v as string[]);
        tx.update(books).set({ updatedAt: now }).where(eq(books.id, bookId)).run();
        break;
      case "series": {
        const links = tx
          .select({ seriesId: bookSeries.seriesId, adminManaged: series.adminManaged })
          .from(bookSeries)
          .innerJoin(series, eq(series.id, bookSeries.seriesId))
          .where(eq(bookSeries.bookId, bookId))
          .all();
        if (links.some((l) => l.adminManaged)) throw httpError(409, "An admin manages this book's series. Change it on the series page.");
        if (links.length)
          tx.delete(bookSeries)
            .where(and(eq(bookSeries.bookId, bookId), inArray(bookSeries.seriesId, links.map((l) => l.seriesId))))
            .run();
        const sv = v as SeriesValue;
        setBookSeries(tx, bookId, sv.name, sv.position ?? undefined);
        tx.update(books).set({ updatedAt: now }).where(eq(books.id, bookId)).run();
        break;
      }
    }
    tx.update(aiMetadataSuggestions).set({ status: "accepted", suggested: v }).where(eq(aiMetadataSuggestions.id, id)).run();
  });
  return { id, bookId, field: s.field, value: v, status: "accepted" as const };
}

export function listMetadataSuggestions(db: Db, status: "pending" | "accepted" | "dismissed", limit: number) {
  return db
    .select({ s: aiMetadataSuggestions, title: books.title })
    .from(aiMetadataSuggestions)
    .innerJoin(books, eq(books.id, aiMetadataSuggestions.bookId))
    .where(eq(aiMetadataSuggestions.status, status))
    .orderBy(books.sortTitle, aiMetadataSuggestions.field)
    .limit(limit)
    .all()
    .map((r) => ({ ...r.s, bookTitle: r.title }));
}

