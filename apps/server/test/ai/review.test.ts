import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { books } from "../../src/db/schema.js";
import { aiMetadataSuggestions, aiRatingSuggestions } from "../../src/ai/schema.js";
import { family, type Family } from "../helpers.js";
import { fakeAi, OLLAMA_SETTINGS } from "./fake.js";

let f: Family;
let ai: ReturnType<typeof fakeAi>;

beforeEach(async () => {
  ai = fakeAi();
  f = await family({ ai: { fetchImpl: ai.fetchImpl } });
  await f.app.inject({ method: "PUT", url: "/api/admin/ai/settings", headers: f.as("admin"), payload: OLLAMA_SETTINGS });
});
afterEach(() => f.close());

const book = (id: string) => f.db.select().from(books).where(eq(books.id, id)).get()!;
const get = async (url: string, who: "admin" | "kid" = "admin") => f.app.inject({ url, headers: f.as(who) });
const post = (url: string, payload: unknown = {}) => f.app.inject({ method: "POST", url, headers: f.as("admin"), payload });

/** Barnaby answers by title: `{ title: [rating, confidence] }`. */
function replies(by: Record<string, [string, number]>) {
  ai.setChat((c) => {
    const text = String(c.body.messages[1].content);
    const hit = Object.entries(by).find(([t]) => text.includes(t));
    const [rating, confidence] = hit?.[1] ?? ["adult", 0.5];
    return JSON.stringify({ rating, confidence, reasons: "because" });
  });
}

async function rate(bookIds?: string[]) {
  const r = await post("/api/admin/ai/rating/run", bookIds ? { bookIds } : {});
  expect(r.statusCode).toBe(202);
  await f.app.jobs.drain();
}

async function saveRatingHelper(ratingHelper: Record<string, unknown>) {
  const r = await f.app.inject({ method: "PUT", url: "/api/admin/ai/settings", headers: f.as("admin"), payload: { ...OLLAMA_SETTINGS, ratingHelper } });
  expect(r.statusCode).toBe(200);
}

describe("one review flow for Barnaby's ratings", () => {
  it("files books Barnaby rated out of the Inbox; looser ratings wait on Needs a rating", async () => {
    const fox = f.book("Little Fox Sleeps", null, { approved: false });
    const spicy = f.book("Velvet Nights", null, { approved: false });
    f.book("Life of Pi", "adult");
    const copy = f.book("Life of Pi", null, { approved: false, sortTitle: "life of pi" });
    const unseen = f.book("Not Looked At", null, { approved: false });
    replies({ Fox: ["kids", 0.9], Velvet: ["explicit", 0.9], Pi: ["adult", 0.9] });
    await rate([fox, spicy, copy]);

    // Approved, but still hidden from kids: unrated counts as adult.
    expect(book(fox)).toMatchObject({ approved: true, rating: null });
    expect((await get(`/api/books/${fox}`, "kid")).statusCode).toBe(404);
    // Stricter: applied and approved.
    expect(book(spicy)).toMatchObject({ approved: true, rating: "explicit", ratingSource: "ai" });
    // A likely copy stays for the admin to merge, with Barnaby's rating shown on it.
    expect(book(copy).approved).toBe(false);

    const inbox = (await get("/api/admin/inbox")).json();
    expect(inbox.items.map((b: { id: string }) => b.id).sort()).toEqual([copy, unseen].sort());
    expect(inbox.counts).toEqual({ all: 2, suggested: 1, unseen: 1 });
    expect(inbox.items.find((b: { id: string }) => b.id === copy).barnaby.rating).toMatchObject({ rating: "adult", confidence: 0.9 });
    expect((await get("/api/admin/inbox?filter=suggested")).json().items.map((b: { id: string }) => b.id)).toEqual([copy]);
    expect((await get("/api/admin/inbox?filter=unseen")).json().items.map((b: { id: string }) => b.id)).toEqual([unseen]);

    // Needs a rating shows the fox with Barnaby's pick, and the dashboard counts it.
    const review = (await get("/api/admin/review/unrated")).json();
    expect(review.items.map((b: { id: string }) => b.id)).toEqual([fox]);
    expect(review.items[0].barnaby.rating).toMatchObject({ rating: "kids" });
    expect((await get("/api/admin/overview")).json().unrated).toBe(1);

    // One tap takes his pick as an admin rating; then a kid can see it.
    const ok = await post("/api/admin/ai/rating/suggestions/accept", { bookIds: [fox] });
    expect(ok.json()).toEqual({ accepted: 1 });
    expect(book(fox)).toMatchObject({ rating: "kids", ratingSource: "admin" });
    expect((await get("/api/admin/review/unrated")).json().total).toBe(0);
    expect((await get(`/api/books/${fox}`, "kid")).statusCode).toBe(200);
  });

  it("can trust confident looser ratings, but never loosens a rating a book already has", async () => {
    const sure = f.book("Sure Picture Book", null);
    const unsure = f.book("Unsure Story", null);
    const genre = f.book("Genre Teen", "teen", { ratingSource: "keywords" });
    replies({ Sure: ["kids", 0.95], Unsure: ["kids", 0.6], Genre: ["kids", 0.99] });
    await rate([sure, unsure, genre]);
    expect(book(sure).rating).toBeNull();

    // Turning it on applies to what Barnaby already rated.
    await saveRatingHelper({ trustLooser: true, minConfidence: 0.8 });
    expect(book(sure)).toMatchObject({ rating: "kids", ratingSource: "ai" });
    expect(book(unsure).rating).toBeNull();
    expect(book(genre)).toMatchObject({ rating: "teen", ratingSource: "keywords" });
    const left = (await get("/api/admin/review/unrated")).json().items.map((b: { id: string }) => b.id);
    expect(left.sort()).toEqual([unsure, genre].sort());
  });

  it("leaves the Inbox alone when filing is off, and files when it's turned back on", async () => {
    await saveRatingHelper({ autoApprove: false });
    const id = f.book("Waiting Book", null, { approved: false });
    replies({ Waiting: ["teen", 0.9] });
    await rate([id]);
    expect(book(id).approved).toBe(false);
    expect((await get("/api/admin/inbox?filter=suggested")).json().items[0].barnaby.rating.rating).toBe("teen");

    await saveRatingHelper({ autoApprove: true });
    expect(book(id).approved).toBe(true);
  });

  it("approves from the Inbox with Barnaby's rating and fixes in one go", async () => {
    await saveRatingHelper({ autoApprove: false });
    const id = f.book("feathers_so_vicious (retail)", null, { approved: false });
    replies({ feathers: ["adult", 0.7] });
    await rate([id]);
    f.db
      .insert(aiMetadataSuggestions)
      .values({ bookId: id, field: "title", current: "feathers_so_vicious (retail)", suggested: "Feathers So Vicious", providerId: "ollama", model: "x" })
      .run();
    const item = (await get("/api/admin/inbox")).json().items[0];
    expect(item.barnaby.fixes).toEqual([expect.objectContaining({ field: "title", suggested: "Feathers So Vicious" })]);

    const r = await post("/api/admin/inbox/approve", { ids: [id], barnabyRating: true, barnabyFixes: true });
    expect(r.json()).toEqual({ approved: 1, rated: 1, fixed: 1 });
    expect(book(id)).toMatchObject({ approved: true, title: "Feathers So Vicious", rating: "adult", ratingSource: "admin" });
    // Nothing left waiting anywhere for this book.
    expect((await get("/api/admin/ai/rating/suggestions")).json().items).toHaveLength(0);
    expect((await get("/api/admin/ai/metadata/suggestions")).json().items).toHaveLength(0);
  });

  it("settles Barnaby's suggestion when an admin picks a rating, so it isn't asked twice", async () => {
    const a = f.book("Agreed", null);
    const b = f.book("Overruled", null);
    replies({ Agreed: ["teen", 0.6], Overruled: ["kids", 0.6] });
    await rate([a, b]);
    await f.app.inject({ method: "PUT", url: `/api/admin/books/${a}/rating`, headers: f.as("admin"), payload: { rating: "teen" } });
    await f.app.inject({ method: "PATCH", url: `/api/admin/books/${b}`, headers: f.as("admin"), payload: { rating: "teen" } });
    const status = (id: string) => f.db.select().from(aiRatingSuggestions).where(eq(aiRatingSuggestions.bookId, id)).get()!.status;
    expect(status(a)).toBe("accepted");
    expect(status(b)).toBe("dismissed");
    expect((await get("/api/admin/review/unrated")).json().total).toBe(0);
  });

  it("keeps the new endpoints admin-only", async () => {
    for (const who of ["kid", "parent", "adult"] as const) {
      for (const url of ["/api/admin/ai/rating/suggestions/accept", "/api/admin/ai/metadata/suggestions/accept"]) {
        const r = await f.app.inject({ method: "POST", url, headers: f.as(who), payload: { bookIds: ["x"] } });
        expect(r.statusCode).toBe(403);
      }
      expect((await f.app.inject({ url: "/api/admin/inbox?filter=suggested", headers: f.as(who) })).statusCode).toBe(403);
    }
  });
});
