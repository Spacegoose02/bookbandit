import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { books } from "../../src/db/schema.js";
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

async function runAndWait() {
  const start = await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: {} });
  expect(start.statusCode).toBe(202);
  for (let i = 0; i < 50; i++) {
    const s = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("rating run never finished");
}

const rating = (id: string) => f.db.select().from(books).where(eq(books.id, id)).get()!;

describe("rating helper", () => {
  it("is admin-only", async () => {
    for (const who of ["kid", "parent", "adult"] as const) {
      expect((await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as(who), payload: {} })).statusCode).toBe(403);
      expect((await f.app.inject({ url: "/api/admin/ai/rating/suggestions", headers: f.as(who) })).statusCode).toBe(403);
    }
  });

  it("locks books it thinks are stricter, and queues the rest for an admin", async () => {
    const spicy = f.book("Velvet Nights", null, { description: "An erotic romance" });
    const picture = f.book("Little Fox Sleeps", null, { description: "A bedtime picture book" });
    const rated = f.book("Already Rated", "teen");
    ai.setChat((c) =>
      String(c.body.messages[1].content).includes("Velvet")
        ? '{"rating":"explicit","confidence":0.9,"reasons":"erotica"}'
        : '{"rating":"kids","confidence":0.85,"reasons":"picture book"}',
    );
    const s = await runAndWait();
    expect(s).toMatchObject({ total: 2, suggested: 2, applied: 1, failed: 0 });

    // Stricter than unrated (adult): applied at once.
    expect(rating(spicy)).toMatchObject({ rating: "explicit", ratingSource: "ai" });
    // Looser: never unlocks on its own.
    expect(rating(picture).rating).toBeNull();
    expect(rating(rated).rating).toBe("teen");

    const q = (await f.app.inject({ url: "/api/admin/ai/rating/suggestions", headers: f.as("admin") })).json();
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ bookId: picture, rating: "kids", title: "Little Fox Sleeps", currentRating: null });

    const ok = await f.app.inject({ method: "POST", url: `/api/admin/ai/rating/suggestions/${picture}/accept`, headers: f.as("admin"), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(rating(picture)).toMatchObject({ rating: "kids", ratingSource: "admin" });

    // Nothing left to rate.
    const again = await runAndWait();
    expect(again.total).toBe(0);
  });

  it("never touches an admin rating", async () => {
    const id = f.book("Admin Says Teen", "teen", { ratingSource: "admin" });
    ai.setChat(() => '{"rating":"explicit","confidence":0.9,"reasons":"x"}');
    await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: { bookIds: [id] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(rating(id)).toMatchObject({ rating: "teen", ratingSource: "admin" });
  });
});
