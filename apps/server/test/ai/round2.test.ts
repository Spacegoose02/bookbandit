/** Barnaby round 2: more like this, meaning search, smart requests, streaming, metadata cleanup. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { books, bookTags, tags } from "../../src/db/schema.js";
import { setBookAuthors, setBookSeries } from "../../src/library/store.js";
import { aiBookEmbeddings } from "../../src/ai/schema.js";
import { family, type Family } from "../helpers.js";
import { EMBED_SETTINGS, fakeAi, OLLAMA_SETTINGS } from "./fake.js";

let f: Family;
let ai: ReturnType<typeof fakeAi>;

beforeEach(async () => {
  ai = fakeAi();
  f = await family({ ai: { fetchImpl: ai.fetchImpl } });
});
afterEach(() => f.close());

type Who = Parameters<Family["as"]>[0];
const get = (who: Who, url: string) => f.app.inject({ url, headers: f.as(who) });
const post = (who: Who, url: string, payload: unknown = {}) => f.app.inject({ method: "POST", url, headers: f.as(who), payload: payload as object });
const configure = (s: object = EMBED_SETTINGS) => f.app.inject({ method: "PUT", url: "/api/admin/ai/settings", headers: f.as("admin"), payload: s });
const enableKid = () =>
  f.app.inject({ method: "PUT", url: `/api/ai/kids/${f.ids.kid}/settings`, headers: f.as("parent"), payload: { enabled: true, webSearch: false, dailyLimit: 30 } });

function tag(bookId: string, name: string) {
  f.db.insert(tags).values({ name, kind: "genre" }).onConflictDoNothing().run();
  const t = f.db.select().from(tags).where(eq(tags.name, name)).get()!;
  f.db.insert(bookTags).values({ bookId, tagId: t.id }).onConflictDoNothing().run();
}

function book(title: string, rating: Parameters<Family["book"]>[1], o: { authors?: string[]; tags?: string[]; series?: string; description?: string } = {}) {
  const id = f.book(title, rating, { description: o.description ?? null });
  if (o.authors) setBookAuthors(f.db, id, o.authors);
  if (o.series) setBookSeries(f.db, id, o.series);
  for (const t of o.tags ?? []) tag(id, t);
  return id;
}

const titles = (items: { title: string }[]) => items.map((b) => b.title);

describe("more like this", () => {
  let quest: string;
  beforeEach(() => {
    quest = book("Pixel Quest", "kids", { authors: ["Ada Park"], tags: ["Adventure", "Video games"], series: "Pixel" });
    book("Pixel Quest 2", "kids", { authors: ["Ada Park"], series: "Pixel" });
    book("Pixel Academy", "middle_grade", { tags: ["Video games"] });
    book("Arcade Kids", "kids", { tags: ["Video games"] });
    book("Level Up Love", "adult", { tags: ["Video games", "Adventure"] });
    book("Unrated Gamer", null, { tags: ["Video games"] });
    book("Inbox Game", "kids", { tags: ["Video games"] });
    f.db.update(books).set({ approved: false }).where(eq(books.title, "Inbox Game")).run();
    book("Cooking Basics", "kids", { tags: ["Cooking"] });
  });

  it("works with no AI set up, ranks series and author first, and explains why", async () => {
    const res = await get("adult", `/api/ai/books/${quest}/similar`);
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items[0]).toMatchObject({ title: "Pixel Quest 2", reason: "Same series: Pixel" });
    expect(titles(items)).toEqual(expect.arrayContaining(["Arcade Kids", "Level Up Love", "Unrated Gamer"]));
    expect(titles(items)).not.toContain("Cooking Basics");
    expect(titles(items)).not.toContain("Pixel Quest");
    expect(items.find((b: { title: string }) => b.title === "Arcade Kids").reason).toBe("Also about video games");
  });

  it("never crosses a kid's limit (rule 1)", async () => {
    // Emma (7) may open kids' books only: no middle grade, adult, unrated or inbox books.
    const items = (await get("kid", `/api/ai/books/${quest}/similar`)).json().items;
    expect(titles(items).sort()).toEqual(["Arcade Kids", "Pixel Quest 2"]);
  });

  it("is a 404 for a book the reader can't see, so neighbours can't leak it", async () => {
    const adult = f.db.select().from(books).where(eq(books.title, "Level Up Love")).get()!.id;
    expect((await get("kid", `/api/ai/books/${adult}/similar`)).statusCode).toBe(404);
    expect((await get("kid", `/api/ai/books/nope/similar`)).statusCode).toBe(404);
  });

  it("adds books with a similar story when meaning search is set up", async () => {
    const robot = book("Tin Heart", "kids", { description: "A lonely robot crosses the frozen sea to find its maker" });
    book("Iron Tide", "kids", { description: "A brave robot sails a frozen sea looking for home" });
    book("Robot Sea Nights", "adult", { description: "A robot crosses the frozen sea, for grown-ups" });
    await configure();
    await f.app.jobs.drain();
    const items = (await get("kid", `/api/ai/books/${robot}/similar`)).json().items;
    expect(items[0]).toMatchObject({ title: "Iron Tide", reason: "A similar story" });
    expect(titles(items)).not.toContain("Robot Sea Nights");
  });
});

describe("meaning search", () => {
  beforeEach(() => {
    book("The Glass Lantern", "kids", { description: "A girl and her talking fox follow a lantern through the haunted marsh to rescue her grandmother" });
    book("Numbers Are Fun", "kids", { description: "Counting from one to ten with farm animals" });
    book("Marsh Fox Murders", "adult", { description: "A detective hunts a killer through the haunted marsh, guided by a fox" });
  });

  it("is off until an embeddings provider is picked", async () => {
    await configure(OLLAMA_SETTINGS);
    expect((await get("adult", "/api/ai/status")).json().meaningSearch).toBe(false);
    expect((await get("adult", "/api/ai/search?q=fox+in+a+marsh")).json()).toEqual({ available: false, items: [] });
  });

  it("indexes on the job runner and finds a book by its plot", async () => {
    await configure();
    await f.app.jobs.drain();
    const st = (await get("admin", "/api/admin/ai/embeddings")).json();
    expect(st).toMatchObject({ configured: true, model: "nomic-embed-text", indexed: 3, total: 3, job: { status: "done" } });
    expect((await get("adult", "/api/ai/status")).json().meaningSearch).toBe(true);

    const res = (await get("adult", "/api/ai/search?q=girl+rescues+grandmother+with+a+talking+fox")).json();
    expect(res.available).toBe(true);
    expect(res.items[0]).toMatchObject({ title: "The Glass Lantern" });
    expect(res.items[0].score).toBeGreaterThan(0.3);
    // nomic gets its task prefixes.
    expect(ai.embedCalls().at(-1)!.body.input[0]).toMatch(/^search_query: /);
    expect(ai.embedCalls()[0]!.body.input[0]).toMatch(/^search_document: /);
  });

  it("only re-embeds books that changed", async () => {
    await configure();
    await f.app.jobs.drain();
    const before = ai.embedCalls().length;
    await post("admin", "/api/admin/ai/embeddings/run");
    await f.app.jobs.drain();
    expect(ai.embedCalls().length).toBe(before);
    f.db.update(books).set({ description: "Totally new plot about pirates" }).where(eq(books.title, "Numbers Are Fun")).run();
    await post("admin", "/api/admin/ai/embeddings/run");
    await f.app.jobs.drain();
    expect(ai.embedCalls().at(-1)!.body.input).toHaveLength(1);
  });

  it("keeps a kid inside their limit, and needs Barnaby turned on for them", async () => {
    await configure();
    await f.app.jobs.drain();
    expect((await get("kid", "/api/ai/search?q=fox+haunted+marsh")).json()).toEqual({ available: false, items: [] });
    await enableKid();
    const res = (await get("kid", "/api/ai/search?q=fox+haunted+marsh")).json();
    expect(titles(res.items)).toContain("The Glass Lantern");
    expect(titles(res.items)).not.toContain("Marsh Fox Murders");
    // Grown-ups see both.
    expect(titles((await get("adult", "/api/ai/search?q=fox+haunted+marsh")).json().items)).toContain("Marsh Fox Murders");
  });

  it("answers gracefully when the embeddings model is down", async () => {
    await configure();
    await f.app.jobs.drain();
    ai.failEmbeddings();
    const res = await get("adult", "/api/ai/search?q=fox");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, items: [] });
  });

  it("admin index routes are admin-only", async () => {
    for (const who of ["kid", "parent", "adult"] as const) {
      expect((await get(who, "/api/admin/ai/embeddings")).statusCode).toBe(403);
      expect((await post(who, "/api/admin/ai/embeddings/run")).statusCode).toBe(403);
    }
  });
});

describe("smart requests", () => {
  beforeEach(async () => {
    book("Pixel Quest", "middle_grade", { authors: ["Ada Park"], tags: ["Video games"] });
    book("Arcade Kids", "kids", { tags: ["Video games"], description: "Two friends win an arcade contest" });
    book("Level Ten", "middle_grade", { tags: ["Video games"], description: "A boy gets stuck inside a video game" });
    book("Respawn", "teen", { tags: ["Video games"], description: "A teen esports drama" });
    book("Game Over Man", "adult", { tags: ["Video games"] });
    await configure(OLLAMA_SETTINGS);
  });

  const reply = (picks: number[] | null) => (c: { body: { messages: { content: string }[] } }) =>
    c.body.messages[0]!.content.startsWith("You help a family")
      ? JSON.stringify({
          like: ["Pixel Quest"],
          age: 10,
          topics: ["video games"],
          search: "a fun video game adventure",
          outside: [
            { title: "Ready Player Two Junior", author: "Someone", reason: "Games!" },
            { title: "Game Over Man", author: "X", reason: "in the library already" },
          ],
        })
      : JSON.stringify({ picks: (picks ?? []).map((n) => ({ n, reason: `Pick ${n}` })) });

  it("caps picks at the age asked for and explains them", async () => {
    ai.setChat(reply([1, 2, 3, 4]));
    const res = await post("parent", "/api/ai/smart-request", { text: "something like Pixel Quest for a 10-year-old" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.interpreted).toMatchObject({ like: ["Pixel Quest"], age: 10, maxRating: "middle_grade", forKid: null });
    expect(titles(body.picks).sort()).toEqual(["Arcade Kids", "Level Ten"]);
    expect(body.picks[0].reason).toMatch(/^Pick /);
    // A title the library has (even one hidden from this reader) is never offered as "request it".
    expect(body.outside).toEqual([{ title: "Ready Player Two Junior", author: "Someone", reason: "Games!" }]);
  });

  it("asking for a kid also applies that kid's own lock", async () => {
    ai.setChat((c) =>
      c.body.messages[0]!.content.startsWith("You help a family")
        ? JSON.stringify({ like: [], age: 16, topics: ["video games"], search: "video games", outside: [] })
        : JSON.stringify({ picks: [] }),
    );
    const body = (await post("parent", "/api/ai/smart-request", { text: "video game books", forKidId: f.ids.kid })).json();
    // The text says 16, but Emma is 7: kids' books only.
    expect(body.interpreted).toMatchObject({ maxRating: "kids", forKid: { id: f.ids.kid, displayName: "Emma" } });
    expect(titles(body.picks)).toEqual(["Arcade Kids"]);
    expect(titles(body.picks).length).toBeGreaterThan(0);
  });

  it("is for grown-ups, and only for kids they manage", async () => {
    ai.setChat(reply(null));
    expect((await post("kid", "/api/ai/smart-request", { text: "dino books" })).statusCode).toBe(403);
    expect((await post("parent", "/api/ai/smart-request", { text: "dino books", forKidId: f.ids.otherKid })).statusCode).toBe(404);
    expect((await post("adult", "/api/ai/smart-request", { text: "dino books", forKidId: f.ids.kid })).statusCode).toBe(404);
  });

  it("falls back to search order when the model's picks are unreadable", async () => {
    ai.setChat(reply(null));
    const body = (await post("adult", "/api/ai/smart-request", { text: "like Pixel Quest for a 10 year old" })).json();
    expect(body.picks.length).toBeGreaterThan(0);
    expect(body.picks[0].reason).toBe("Fits what you asked for.");
  });
});

describe("streaming chat", () => {
  function events(body: string) {
    return body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => {
        const ev = /^event: (.+)$/m.exec(chunk)![1]!;
        return { ev, data: JSON.parse(/^data: (.+)$/m.exec(chunk)![1]!) };
      });
  }

  it("streams a grown-up's reply piece by piece, then the saved turn", async () => {
    await configure(OLLAMA_SETTINGS);
    ai.setChat(() => "Once upon a time there was a raccoon.");
    const res = await post("adult", "/api/ai/chat/stream", { message: "Tell me a story" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const ev = events(res.body);
    const deltas = ev.filter((e) => e.ev === "delta").map((e) => e.data.text);
    expect(deltas.length).toBe(3);
    expect(deltas.join("")).toBe("Once upon a time there was a raccoon.");
    const done = ev.at(-1)!;
    expect(done.ev).toBe("done");
    expect(done.data.reply.content).toBe("Once upon a time there was a raccoon.");
    expect(ai.chatCalls().at(-1)!.body.stream).toBe(true);
    // It's saved like any other turn.
    const conv = (await get("adult", `/api/ai/conversations/${done.data.conversationId}`)).json();
    expect(conv.messages).toHaveLength(2);
  });

  it("checks a kid's reply before showing any of it", async () => {
    await configure(OLLAMA_SETTINGS);
    await enableKid();
    ai.setChat(() => "Dinosaurs are big!");
    const ev = events((await post("kid", "/api/ai/chat/stream", { message: "Tell me about dinosaurs" })).body);
    expect(ev.map((e) => e.ev)).toEqual(["done"]);
    expect(ev[0]!.data.reply.content).toBe("Dinosaurs are big!");
    expect(ai.chatCalls().at(-1)!.body.stream).toBe(false);
  });

  it("returns plain JSON errors for checks that fail before the model is called", async () => {
    expect((await post("adult", "/api/ai/chat/stream", { message: "hi" })).statusCode).toBe(503);
    await configure(OLLAMA_SETTINGS);
    const res = await post("kid", "/api/ai/chat/stream", { message: "hi" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "off" });
  });
});

describe("metadata cleanup", () => {
  let messy: string;
  beforeEach(async () => {
    messy = book("the_hobbit_v2 (retail)", "kids", { authors: ["Tolkien, J.R.R."], description: "<p>In a hole in the ground</p> BUY NOW" });
    book("Clean Book", "kids", { authors: ["Ann Lee"] });
    await configure(OLLAMA_SETTINGS);
    ai.setChat((c) =>
      String(c.body.messages[1].content).includes("the_hobbit")
        ? JSON.stringify({
            title: "The Hobbit",
            subtitle: null,
            authors: ["J. R. R. Tolkien"],
            series: null,
            description: "In a hole in the ground",
            reason: "Cleaned the file name and author order",
          })
        : JSON.stringify({ title: "Clean Book", authors: ["Ann Lee"], reason: "Looks fine" }),
    );
  });

  async function run(payload: object = {}) {
    const r = await post("admin", "/api/admin/ai/metadata/run", payload);
    expect(r.statusCode).toBe(202);
    await f.app.jobs.drain();
    return (await get("admin", "/api/admin/ai/metadata/run")).json();
  }
  const pending = async () => (await get("admin", "/api/admin/ai/metadata/suggestions")).json().items as { id: string; field: string; suggested: unknown; current: unknown; bookTitle: string }[];

  it("suggests only fields that would change, and an admin accepts each one", async () => {
    const st = await run();
    expect(st).toMatchObject({ running: false, total: 2, done: 2, suggested: 1, applied: 3, failed: 0 });
    const items = await pending();
    expect(items.map((i) => i.field).sort()).toEqual(["authors", "description", "title"]);
    const title = items.find((i) => i.field === "title")!;
    expect(title).toMatchObject({ current: "the_hobbit_v2 (retail)", suggested: "The Hobbit", bookTitle: "the_hobbit_v2 (retail)" });

    // Nothing changed yet.
    expect(f.db.select().from(books).where(eq(books.id, messy)).get()!.title).toBe("the_hobbit_v2 (retail)");

    expect((await post("admin", `/api/admin/ai/metadata/suggestions/${title.id}/accept`)).statusCode).toBe(200);
    const authors = items.find((i) => i.field === "authors")!;
    expect((await post("admin", `/api/admin/ai/metadata/suggestions/${authors.id}/accept`, { value: ["J.R.R. Tolkien"] })).json().value).toEqual(["J.R.R. Tolkien"]);
    const desc = items.find((i) => i.field === "description")!;
    expect((await post("admin", `/api/admin/ai/metadata/suggestions/${desc.id}/dismiss`)).statusCode).toBe(200);

    const detail = (await get("admin", `/api/books/${messy}`)).json();
    expect(detail.title).toBe("The Hobbit");
    expect(detail.authors.map((a: { name: string }) => a.name)).toEqual(["J.R.R. Tolkien"]);
    expect(detail.description).toContain("BUY NOW");
    expect(await pending()).toHaveLength(0);

    // A second run only looks at new books; asking for this book again doesn't repeat the dismissed change.
    expect((await run()).total).toBe(0);
    await run({ bookIds: [messy] });
    expect((await pending()).map((i) => i.field)).not.toContain("description");
  });

  it("is admin-only", async () => {
    for (const who of ["kid", "parent", "adult"] as const) {
      expect((await post(who, "/api/admin/ai/metadata/run")).statusCode).toBe(403);
      expect((await get(who, "/api/admin/ai/metadata/suggestions")).statusCode).toBe(403);
      expect((await post(who, "/api/admin/ai/metadata/suggestions/x/accept")).statusCode).toBe(403);
    }
  });

  it("re-embeds a book after an accepted change", async () => {
    await configure();
    await f.app.jobs.drain();
    await run({ bookIds: [messy] });
    const title = (await pending()).find((i) => i.field === "title")!;
    const before = ai.embedCalls().length;
    await post("admin", `/api/admin/ai/metadata/suggestions/${title.id}/accept`);
    await f.app.jobs.drain();
    expect(ai.embedCalls().length).toBe(before + 1);
    expect(f.db.select().from(aiBookEmbeddings).where(eq(aiBookEmbeddings.bookId, messy)).get()).toBeTruthy();
  });
});
