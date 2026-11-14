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
  expect(start.json().running).toBe(true);
  await f.app.jobs.drain();
  const s = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
  expect(s.running).toBe(false);
  return s;
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

    // Nothing left to rate: the page shows "all done" and a new run has nothing to start.
    const after = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    expect(after.progress).toMatchObject({ remaining: 0, waiting: 0, failed: 0 });
    const again = await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: {} });
    expect(again.statusCode).toBe(409);
  });

  it("never touches an admin rating", async () => {
    const id = f.book("Admin Says Teen", "teen", { ratingSource: "admin" });
    ai.setChat(() => '{"rating":"explicit","confidence":0.9,"reasons":"x"}');
    await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: { bookIds: [id] } });
    await f.app.jobs.drain();
    expect(rating(id)).toMatchObject({ rating: "teen", ratingSource: "admin" });
  });

  it("runs on the job runner: one run at a time, visible on the jobs page", async () => {
    f.book("Unrated One", null);
    ai.setChat(() => '{"rating":"teen","confidence":0.7,"reasons":"x"}');
    const first = await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: {} });
    expect(first.statusCode).toBe(202);
    const second = await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: {} });
    expect(second.statusCode).toBe(409);
    const jobsList = (await f.app.inject({ url: "/api/admin/jobs", headers: f.as("admin") })).json();
    expect(JSON.stringify(jobsList)).toContain("ai.rating");
    await f.app.jobs.drain();
    const s = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    expect(s).toMatchObject({ running: false, total: 1, done: 1, suggested: 1 });
  });

  it("skips a book it couldn't read in later batches, and tries it again only when asked", async () => {
    const good = f.book("Little Fox Sleeps", null);
    const bad = f.book("Garbled Reply", null);
    ai.setChat((c) => (String(c.body.messages[1].content).includes("Garbled") ? "no idea, sorry" : '{"rating":"kids","confidence":0.8,"reasons":"x"}'));
    const s = await runAndWait();
    expect(s).toMatchObject({ total: 2, suggested: 1, failed: 1 });
    expect(s.progress).toMatchObject({ total: 2, remaining: 0, waiting: 1, failed: 1 });

    // The failed book doesn't come back at the front of the next batch.
    const next = await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: {} });
    expect(next.statusCode).toBe(409);

    ai.setChat(() => '{"rating":"teen","confidence":0.8,"reasons":"x"}');
    const retry = await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: { retryFailed: true } });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().total).toBe(1);
    await f.app.jobs.drain();
    const after = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    expect(after.progress).toMatchObject({ remaining: 0, waiting: 2, failed: 0 });
    expect(rating(good).rating).toBeNull();
    expect(rating(bad).rating).toBeNull();
  });

  it("works through the library 25 at a time, or everything left in one run", async () => {
    for (let i = 0; i < 30; i++) f.book(`Unrated ${i}`, null);
    ai.setChat(() => '{"rating":"kids","confidence":0.8,"reasons":"x"}');
    const first = await runAndWait();
    expect(first.total).toBe(25);
    expect(first.progress).toMatchObject({ total: 30, remaining: 5, waiting: 25 });

    const all = await f.app.inject({ method: "POST", url: "/api/admin/ai/rating/run", headers: f.as("admin"), payload: { all: true } });
    expect(all.json().total).toBe(5);
    await f.app.jobs.drain();
    const done = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    expect(done.progress).toMatchObject({ total: 30, remaining: 0, waiting: 30, failed: 0 });
  });

  it("estimates cost: free on a local server, priced from the usage log on a cloud one", async () => {
    f.book("Unrated", null);
    const local = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    expect(local.estimate).toMatchObject({ provider: "Ollama", source: "local", free: true, perBook: 0 });

    await f.app.inject({
      method: "PUT",
      url: "/api/admin/ai/settings",
      headers: f.as("admin"),
      payload: {
        ...OLLAMA_SETTINGS,
        providers: [
          ...OLLAMA_SETTINGS.providers,
          { id: "cloud", name: "Cloud", kind: "openai", baseUrl: "https://api.example.com/v1", model: "gpt-5-mini", apiKey: "k", price: { input: 1, output: 2 } },
        ],
        features: { ...OLLAMA_SETTINGS.features, rating: "cloud" },
      },
    });
    const before = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    // No calls yet: a first guess of 1800 tokens in and 80 out.
    expect(before.estimate).toMatchObject({ source: "custom", free: false, basis: "guess" });
    expect(before.estimate.perBook).toBeCloseTo((1800 * 1 + 80 * 2) / 1e6);

    ai.setChat(() => '{"rating":"kids","confidence":0.8,"reasons":"x"}');
    await runAndWait();
    // The fake model reports 10 tokens in and 5 out per call.
    const after = (await f.app.inject({ url: "/api/admin/ai/rating/run", headers: f.as("admin") })).json();
    expect(after.spent).toMatchObject({ calls: 1, partial: false });
    expect(after.spent.dollars).toBeCloseTo((10 * 1 + 5 * 2) / 1e6);
  });
});
