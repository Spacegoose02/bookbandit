/**
 * Meaning search: one embedding per book (title, authors, series, genres and description, or the
 * opening of the text when there's no description), stored in SQLite and compared in memory.
 *
 * Every lookup that returns books starts from `visibleBooksWhere(reader)`, so a kid's meaning
 * search and "more like this" never cross their limit (CLAUDE.md rule 1).
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookFiles, books } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import type { AiContext } from "./context.js";
import { bookFacts, type BookFacts } from "./book-facts.js";
import { openingText } from "./booktext.js";
import { makeProvider, type AiProvider } from "./providers/index.js";
import { aiBookEmbeddings } from "./schema.js";
import { getAiSettings, providerFor } from "./settings.js";
import { tracked } from "./usage.js";

const BATCH = 16;

export function embeddingProvider(ctx: AiContext): AiProvider | null {
  const config = providerFor(getAiSettings(ctx.db, ctx.box), "embeddings");
  return config ? makeProvider(config, ctx.fetchImpl) : null;
}

/** nomic-embed-text wants task prefixes; other models ignore them harmlessly, so only add them for nomic. */
function prefixed(model: string, kind: "query" | "document", text: string): string {
  if (!/nomic/i.test(model)) return text;
  return `${kind === "query" ? "search_query" : "search_document"}: ${text}`;
}

export function bookEmbeddingText(book: Pick<typeof books.$inferSelect, "title" | "subtitle" | "description">, facts: BookFacts | undefined, opening?: string | null): string {
  const lines = [
    `${book.title}${book.subtitle ? `: ${book.subtitle}` : ""}`,
    facts?.authors.length ? `by ${facts.authors.map((a) => a.name).join(", ")}` : "",
    facts?.series.length ? `Series: ${facts.series.map((s) => s.name).join(", ")}` : "",
    facts?.tags.length ? `Genres: ${facts.tags.map((t) => t.name).join(", ")}` : "",
    book.description ? book.description.slice(0, 2500) : "",
    !book.description && opening ? opening.slice(0, 2000) : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

export function encodeVector(v: number[]): Buffer {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const f = new Float32Array(v.length);
  v.forEach((x, i) => (f[i] = x / norm));
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeVector(b: Buffer): Float32Array {
  // Copy so the Float32Array is aligned regardless of the Buffer's offset.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// ---- In-memory vectors, so a search doesn't decode every row each time ----------------------

interface VectorCache {
  model: string;
  version: number;
  vectors: Map<string, Float32Array>;
}
const caches = new WeakMap<Db, VectorCache>();
const versions = new WeakMap<Db, number>();
const bump = (db: Db) => versions.set(db, (versions.get(db) ?? 0) + 1);

function vectorsFor(db: Db, model: string): Map<string, Float32Array> {
  const version = versions.get(db) ?? 0;
  const c = caches.get(db);
  if (c && c.model === model && c.version === version) return c.vectors;
  const vectors = new Map<string, Float32Array>();
  for (const r of db.select({ bookId: aiBookEmbeddings.bookId, vector: aiBookEmbeddings.vector }).from(aiBookEmbeddings).where(eq(aiBookEmbeddings.model, model)).all())
    vectors.set(r.bookId, decodeVector(r.vector));
  caches.set(db, { model, version, vectors });
  return vectors;
}

// ---- Indexing (runs as the ai.embed job) -----------------------------------------------------

export interface IndexResult {
  embedded: number;
  unchanged: number;
  failed: number;
}

export async function indexBooks(
  ctx: AiContext,
  opts: { bookIds?: string[]; signal?: AbortSignal; progress?: (f: number) => void; log?: (m: string) => void; userId?: string | null } = {},
): Promise<IndexResult> {
  const provider = embeddingProvider(ctx);
  if (!provider) throw new Error("Pick an embeddings provider in Barnaby settings first");
  const { db } = ctx;
  const model = provider.config.model;
  const rows = db
    .select({ id: books.id, title: books.title, subtitle: books.subtitle, description: books.description })
    .from(books)
    .where(opts.bookIds?.length ? inArray(books.id, opts.bookIds) : undefined)
    .all();
  const facts = bookFacts(db, rows.map((r) => r.id));
  const existing = new Map(
    db
      .select({ bookId: aiBookEmbeddings.bookId, textHash: aiBookEmbeddings.textHash, model: aiBookEmbeddings.model })
      .from(aiBookEmbeddings)
      .all()
      .map((r) => [r.bookId, r]),
  );
  const result: IndexResult = { embedded: 0, unchanged: 0, failed: 0 };
  const todo: { id: string; text: string; hash: string }[] = [];
  for (const r of rows) {
    // The hash covers the metadata only, so an unchanged book without a description isn't re-read from disk.
    const h = hash(bookEmbeddingText(r, facts.get(r.id)));
    const old = existing.get(r.id);
    if (old && old.model === model && old.textHash === h) {
      result.unchanged++;
      continue;
    }
    let opening: string | null = null;
    if (!r.description) {
      const files = db.select({ relPath: bookFiles.relPath, format: bookFiles.format }).from(bookFiles).where(eq(bookFiles.bookId, r.id)).all();
      if (files.length) opening = await openingText(ctx.booksDir, files, 2000).catch(() => null);
    }
    todo.push({ id: r.id, text: bookEmbeddingText(r, facts.get(r.id), opening), hash: h });
  }
  opts.log?.(`${todo.length} of ${rows.length} books need an embedding (${model})`);
  for (let i = 0; i < todo.length; i += BATCH) {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    const batch = todo.slice(i, i + BATCH);
    try {
      const r = await tracked(ctx, provider, "embeddings", opts.userId ?? null, () => provider.embed(batch.map((b) => prefixed(model, "document", b.text))));
      if (r.vectors.length !== batch.length) throw new Error(`asked for ${batch.length} embeddings, got ${r.vectors.length}`);
      const now = ctx.now().getTime();
      db.transaction((tx) => {
        batch.forEach((b, j) => {
          const v = r.vectors[j]!;
          const row = { bookId: b.id, providerId: provider.config.id, model, dims: v.length, vector: encodeVector(v), textHash: b.hash, updatedAt: now };
          tx.insert(aiBookEmbeddings).values(row).onConflictDoUpdate({ target: aiBookEmbeddings.bookId, set: row }).run();
        });
      });
      result.embedded += batch.length;
    } catch (e) {
      // One bad batch shouldn't stop the rest; a provider that's down fails every batch, so stop early.
      result.failed += batch.length;
      opts.log?.(`Batch failed: ${(e as Error).message}`);
      if (result.embedded === 0 && result.failed >= BATCH * 2) throw e;
    }
    bump(db);
    opts.progress?.(Math.min(1, (i + batch.length) / todo.length));
  }
  bump(db);
  return result;
}

export function embeddingStatus(ctx: AiContext) {
  const provider = embeddingProvider(ctx);
  const total = ctx.db.select({ n: sql<number>`count(*)` }).from(books).get()?.n ?? 0;
  if (!provider) return { configured: false, model: null, indexed: 0, total };
  const indexed =
    ctx.db.select({ n: sql<number>`count(*)` }).from(aiBookEmbeddings).where(eq(aiBookEmbeddings.model, provider.config.model)).get()?.n ?? 0;
  return { configured: true, model: provider.config.model, indexed, total };
}

// ---- Lookups ---------------------------------------------------------------------------------

export interface Scored {
  bookId: string;
  score: number;
}

/** Ids of books this reader may see that have an embedding for `model`. */
function visibleIds(db: Db, reader: Reader, model: string, now: Date, exclude?: string): Set<string> {
  return new Set(
    db
      .select({ id: aiBookEmbeddings.bookId })
      .from(aiBookEmbeddings)
      .innerJoin(books, eq(books.id, aiBookEmbeddings.bookId))
      .where(and(eq(aiBookEmbeddings.model, model), visibleBooksWhere(reader, now), exclude ? ne(books.id, exclude) : undefined))
      .all()
      .map((r) => r.id),
  );
}

function rank(query: Float32Array, vectors: Map<string, Float32Array>, allowed: Set<string>, limit: number, minScore: number): Scored[] {
  const out: Scored[] = [];
  for (const id of allowed) {
    const v = vectors.get(id);
    if (!v) continue;
    const score = dot(query, v);
    if (score >= minScore) out.push({ bookId: id, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Books whose meaning is closest to `q`. Null when meaning search isn't set up. */
export async function meaningSearch(ctx: AiContext, reader: Reader, q: string, limit: number, minScore = 0.25): Promise<Scored[] | null> {
  const provider = embeddingProvider(ctx);
  if (!provider) return null;
  const model = provider.config.model;
  const allowed = visibleIds(ctx.db, reader, model, ctx.now());
  if (!allowed.size) return [];
  const r = await tracked(ctx, provider, "embeddings", reader.userId, () => provider.embed([prefixed(model, "query", q)]));
  const v = r.vectors[0];
  if (!v?.length) return [];
  return rank(decodeVector(encodeVector(v)), vectorsFor(ctx.db, model), allowed, limit, minScore);
}

/** Books closest to one book, by stored embeddings only (no provider call). */
export function nearestBooks(ctx: AiContext, reader: Reader, bookId: string, limit: number): Scored[] {
  const provider = embeddingProvider(ctx);
  if (!provider) return [];
  const model = provider.config.model;
  const vectors = vectorsFor(ctx.db, model);
  const self = vectors.get(bookId);
  if (!self) return [];
  return rank(self, vectors, visibleIds(ctx.db, reader, model, ctx.now(), bookId), limit, 0);
}
