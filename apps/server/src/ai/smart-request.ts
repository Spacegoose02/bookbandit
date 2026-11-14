/**
 * Smart requests: "something like Pixel Quest for a 10-year-old". The model turns the words into
 * a search (example titles, age, topics); the library is searched behind the content lock and
 * an age cap; the model then picks the best few and explains why, and names a few well-known
 * books the library doesn't have, which the person can request.
 *
 * Grown-ups only. Asking for a kid (`forKidId`, a kid they manage) also limits picks to what that
 * kid may open. Kids find books by chatting with Barnaby, which has its own log and limits.
 */
import { and, inArray, or, sql, type SQL } from "drizzle-orm";
import { CONTENT_RATINGS, ratingRank, ageFromBirthYear, maxAllowedRating, type ContentRating } from "@bookbandit/shared";
import { books, bookTags, tags } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { toReader } from "../auth/reader.js";
import { httpError } from "../auth/plugin.js";
import { loadManagedUser } from "../auth/permissions.js";
import { visibleBooksWhere } from "../content/lock.js";
import { likePattern, type BookSummary } from "../catalog/list.js";
import { matchKey } from "../metadata/text.js";
import type { AiContext } from "./context.js";
import { meaningSearch } from "./embeddings.js";
import { makeProvider } from "./providers/index.js";
import { fuse, moreLikeThis, ratingForAge, summaries } from "./recommend.js";
import { getAiSettings, providerFor } from "./settings.js";
import { tracked } from "./usage.js";

export interface SmartRequestInput {
  text: string;
  forKidId?: string;
}

export interface Interpretation {
  like: string[];
  age: number | null;
  topics: string[];
  search: string;
  outside: { title: string; author: string; reason: string }[];
}

export interface SmartRequestResult {
  interpreted: { like: string[]; age: number | null; topics: string[]; maxRating: ContentRating; forKid: { id: string; displayName: string } | null };
  picks: (BookSummary & { reason: string })[];
  outside: { title: string; author: string; reason: string }[];
}

const PARSE_PROMPT = [
  "You help a family find books in their home library. Turn the request into a search.",
  "Reply with JSON only:",
  '{"like": ["titles named as examples"], "age": number or null, "topics": ["up to 6 short genres or themes"], "search": "one sentence describing the wanted book, for a search engine", "outside": [{"title": "", "author": "", "reason": "one short sentence"}]}',
  "- age: the reader's age if stated or implied (\"my 10-year-old\" = 10, \"third grader\" = 8, \"teen\" = 14, \"toddler\" = 3), else null.",
  "- outside: up to 3 real, well-known published books that fit the request and the age. Never invent books.",
].join("\n");

const PICK_PROMPT = [
  "You are Barnaby, the friendly raccoon librarian of a family's home library.",
  "Pick up to 5 books from the numbered list that best fit the request. Only use books from the list.",
  'Reply with JSON only: {"picks": [{"n": 1, "reason": "one warm sentence on why it fits"}]}',
].join("\n");

function json<T>(text: string): T | null {
  const m = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!m) return null;
  try {
    return JSON.parse(m) as T;
  } catch {
    return null;
  }
}

const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");

export function parseInterpretation(text: string, fallback: string): Interpretation {
  const o = json<Record<string, unknown>>(text) ?? {};
  const list = (x: unknown, max: number) => (Array.isArray(x) ? x.map((v) => str(v, 120)).filter(Boolean).slice(0, max) : []);
  const age = Number(o.age);
  return {
    like: list(o.like, 3),
    age: Number.isFinite(age) && age > 0 && age < 120 ? Math.round(age) : null,
    topics: list(o.topics, 6),
    search: str(o.search, 300) || fallback,
    outside: (Array.isArray(o.outside) ? o.outside : [])
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({ title: str(x.title, 200), author: str(x.author, 120), reason: str(x.reason, 300) }))
      .filter((x) => x.title)
      .slice(0, 3),
  };
}

/** Book ids whose title, genres or description mention any of the words. */
function keywordIds(ctx: AiContext, reader: Reader, words: string[], extra: SQL | undefined): string[] {
  const terms = words.filter((w) => w.length >= 3).slice(0, 8);
  if (!terms.length) return [];
  const match = or(
    ...terms.flatMap((t) => {
      const p = likePattern(t);
      return [
        sql`${books.title} like ${p} escape '\\'`,
        sql`${books.description} like ${p} escape '\\'`,
        sql`exists (select 1 from ${bookTags} join ${tags} on ${tags.id} = ${bookTags.tagId} where ${bookTags.bookId} = ${books.id} and ${tags.name} like ${p} escape '\\')`,
      ];
    }),
  );
  return ctx.db
    .select({ id: books.id })
    .from(books)
    .where(and(visibleBooksWhere(reader, ctx.now()), extra, match))
    .limit(40)
    .all()
    .map((r) => r.id);
}

/** Visible books whose title matches one of the example titles. */
function findTitles(ctx: AiContext, reader: Reader, titles: string[]): string[] {
  const out: string[] = [];
  for (const t of titles) {
    const key = matchKey(t);
    if (!key) continue;
    const rows = ctx.db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(and(visibleBooksWhere(reader, ctx.now()), sql`${books.title} like ${likePattern(t.split(/[:(]/)[0]!.trim())} escape '\\'`))
      .limit(5)
      .all();
    const hit = rows.find((r) => matchKey(r.title) === key) ?? rows[0];
    if (hit) out.push(hit.id);
  }
  return out;
}

export async function smartRequest(ctx: AiContext, reader: Reader, input: SmartRequestInput): Promise<SmartRequestResult> {
  if (reader.isKid) throw Object.assign(httpError(403, "Ask Barnaby in the chat to find you a book!"), { code: "grown_ups_only" });
  const { db } = ctx;
  const now = ctx.now();
  const settings = getAiSettings(db, ctx.box);
  const config = providerFor(settings, "chat");
  if (!config) throw Object.assign(httpError(503, "Barnaby isn't set up yet. An admin can add an AI provider in settings."), { code: "not_configured" });
  const provider = makeProvider(config, ctx.fetchImpl);

  // The kid this is for, if any: only their own parent or an admin can ask (404 otherwise).
  const kidRow = input.forKidId ? loadManagedUser(db, reader, input.forKidId) : null;
  if (kidRow && kidRow.role !== "kid") throw httpError(404, "Not found");
  const kid = kidRow ? toReader(kidRow) : null;

  const parsed = parseInterpretation(
    (
      await tracked(ctx, provider, "smartRequest", reader.userId, () =>
        provider.chat({ system: PARSE_PROMPT, messages: [{ role: "user", content: input.text }], maxTokens: 500, temperature: 0, json: true }),
      )
    ).text,
    input.text,
  );

  const age = parsed.age ?? (kid?.birthYear != null ? ageFromBirthYear(kid.birthYear, now) : null);
  let maxRating: ContentRating = age != null ? ratingForAge(age) : "adult";
  if (kid) {
    const kidMax = maxAllowedRating(kid, now);
    if (ratingRank(kidMax) < ratingRank(maxRating)) maxRating = kidMax;
  }
  // The cap narrows what the reader may see, never widens it. Unrated books count as adult, so
  // any cap below adult leaves them out.
  const capped = CONTENT_RATINGS.filter((r) => ratingRank(r) <= ratingRank(maxRating) && r !== "explicit");
  const extra = and(maxRating === "adult" ? undefined : inArray(books.rating, capped), kid ? visibleBooksWhere(kid, now) : undefined);

  const likeIds = findTitles(ctx, reader, parsed.like);
  const lists: string[][] = [];
  for (const id of likeIds) lists.push(moreLikeThis(ctx, reader, id, 20, extra).map((b) => b.id));
  const meaning = await meaningSearch(ctx, reader, parsed.search, 30).catch(() => null);
  if (meaning) {
    const allowed = new Set(summaries(db, reader, meaning.map((m) => m.bookId), now, extra).map((b) => b.id));
    lists.push(meaning.map((m) => m.bookId).filter((id) => allowed.has(id)));
  }
  lists.push(keywordIds(ctx, reader, [...parsed.topics, ...parsed.search.split(/\s+/).filter((w) => w.length >= 5)], extra));
  const ranked = [...fuse(lists).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => !likeIds.includes(id));
  const pool = summaries(db, reader, ranked, now, extra).slice(0, 12);

  let picks: (BookSummary & { reason: string })[] = [];
  if (pool.length) {
    const facts = db
      .select({ id: books.id, description: books.description })
      .from(books)
      .where(inArray(books.id, pool.map((b) => b.id)))
      .all();
    const desc = new Map(facts.map((f) => [f.id, f.description]));
    const list = pool
      .map((b, i) => `${i + 1}. "${b.title}"${b.authors.length ? ` by ${b.authors.map((a) => a.name).join(", ")}` : ""}: ${(desc.get(b.id) ?? "").slice(0, 300)}`)
      .join("\n");
    try {
      const r = await tracked(ctx, provider, "smartRequest", reader.userId, () =>
        provider.chat({
          system: PICK_PROMPT,
          messages: [{ role: "user", content: `Request: ${input.text}${age != null ? `\nReader's age: ${age}` : ""}\n\nBooks:\n${list}` }],
          maxTokens: 600,
          temperature: 0.3,
          json: true,
        }),
      );
      const o = json<{ picks?: { n?: unknown; reason?: unknown }[] }>(r.text);
      const seen = new Set<number>();
      for (const p of o?.picks ?? []) {
        const n = Number(p.n);
        const b = pool[n - 1];
        if (!b || seen.has(n)) continue;
        seen.add(n);
        picks.push({ ...b, reason: str(p.reason, 300) || "Fits what you asked for." });
        if (picks.length >= 5) break;
      }
    } catch {
      /* fall back to the search order below */
    }
    if (!picks.length) picks = pool.slice(0, 5).map((b) => ({ ...b, reason: "Fits what you asked for." }));
  }

  // Outside ideas the library doesn't have. A title that's already in the library (visible or
  // not) is dropped, so this never hints at a locked book.
  const libraryKeys = new Set(
    parsed.outside.length
      ? db
          .select({ title: books.title })
          .from(books)
          .where(or(...parsed.outside.map((o) => sql`${books.title} like ${likePattern(o.title)} escape '\\'`)))
          .all()
          .map((b) => matchKey(b.title))
      : [],
  );
  const outside = parsed.outside.filter((o) => !libraryKeys.has(matchKey(o.title)));

  return {
    interpreted: {
      like: parsed.like,
      age,
      topics: parsed.topics,
      maxRating,
      forKid: kidRow ? { id: kidRow.id, displayName: kidRow.displayName } : null,
    },
    picks,
    outside,
  };
}

