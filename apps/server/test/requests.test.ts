import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookRequests, users } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";

/** Fake outside world: Open Library search and Google Books lookups by title. */
interface FakeBook {
  title: string;
  author: string;
  subjects?: string[];
  mature?: boolean;
  isbn?: string;
}
const WORLD: FakeBook[] = [
  { title: "Charlotte's Web", author: "E. B. White", subjects: ["Picture books", "Pigs"], isbn: "9780064400558" },
  { title: "Fifty Shades of Grey", author: "E. L. James", subjects: ["Erotica"], mature: true },
  { title: "The Hunger Games", author: "Suzanne Collins", subjects: ["Young adult fiction"] },
  { title: "Gone Girl", author: "Gillian Flynn", subjects: ["Thrillers"] },
];

function fakeFetch(calls: string[] = []) {
  return async (input: string) => {
    calls.push(input);
    const url = new URL(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.host === "openlibrary.org" && url.pathname === "/search.json") {
      const q = (url.searchParams.get("q") ?? url.searchParams.get("title") ?? "").toLowerCase();
      const isbn = url.searchParams.get("isbn");
      const hits = WORLD.filter((b) => (isbn ? b.isbn === isbn : q.split(/\s+/).some((w) => w.length > 2 && b.title.toLowerCase().includes(w))));
      return json({
        docs: hits.map((b, i) => ({ key: `/works/OL${i}W`, title: b.title, author_name: [b.author], subject: b.subjects, isbn: b.isbn ? [b.isbn] : [], cover_i: 100 + i })),
      });
    }
    if (url.host === "www.googleapis.com") {
      const q = url.searchParams.get("q") ?? "";
      const b = WORLD.find((x) => q.toLowerCase().includes(x.title.toLowerCase().replace(/'/g, "")) || q.toLowerCase().includes(x.title.toLowerCase()));
      if (!b) return json({ totalItems: 0 });
      return json({
        items: [
          {
            id: "g1",
            volumeInfo: { title: b.title, authors: [b.author], categories: b.subjects, maturityRating: b.mature ? "MATURE" : "NOT_MATURE" },
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  };
}

let f: Family;
beforeEach(async () => {
  f = await family({ requests: { fetchImpl: fakeFetch() }, integrations: { fetchImpl: fakeFetch() } });
});
afterEach(async () => {
  await f.close();
});

type Who = Parameters<Family["as"]>[0];
const ask = (who: Who, payload: Record<string, unknown>) =>
  f.app.inject({ method: "POST", url: "/api/requests", headers: f.as(who), payload });
const list = (who: Who, scope = "mine") => f.app.inject({ url: `/api/requests?scope=${scope}`, headers: f.as(who) });
const act = (who: Who, id: string, what: "approve" | "decline", note?: string) =>
  f.app.inject({ method: "POST", url: `/api/requests/${id}/${what}`, headers: f.as(who), payload: note ? { note } : {} });

describe("making requests", () => {
  it("needs sign-in and a title", async () => {
    expect((await f.app.inject({ method: "POST", url: "/api/requests", payload: { title: "x" } })).statusCode).toBe(401);
    expect((await ask("adult", { title: "" })).statusCode).toBe(400);
  });

  it("auto-declines a kid's request above their rating, using the server's own lookup", async () => {
    const res = await ask("kid", { title: "Fifty Shades of Grey", author: "E. L. James" });
    expect(res.statusCode).toBe(201);
    expect(res.json().request).toMatchObject({ status: "declined", rating: "explicit", canApprove: false, canCancel: false });
    expect(res.json().request.note).toMatch(/above/);
  });

  it("keeps a kid's request pending when the rating is within their limit or unknown", async () => {
    const ok = await ask("kid", { title: "Charlotte's Web", author: "E. B. White" });
    expect(ok.json().request).toMatchObject({ status: "pending", rating: "kids" });
    const unknown = await ask("kid", { title: "Some Book Nobody Knows" });
    expect(unknown.json().request).toMatchObject({ status: "pending", rating: null });
  });

  it("approves an admin's own request at once and leaves adults' pending", async () => {
    expect((await ask("admin", { title: "Gone Girl" })).json().request.status).toBe("approved");
    expect((await ask("adult", { title: "Gone Girl" })).json().request.status).toBe("pending");
  });

  it("returns the existing request instead of a duplicate", async () => {
    const a = await ask("adult", { title: "Gone Girl" });
    const b = await ask("adult", { title: "gone girl" });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ duplicate: true, request: { id: a.json().request.id } });
  });

  it("says a visible book is already in the library, but never reveals a locked one", async () => {
    const kidsBook = f.book("Charlotte's Web", "kids");
    f.book("Gone Girl", "adult");
    const owned = await ask("kid", { title: "Charlotte's Web" });
    expect(owned.statusCode).toBe(409);
    expect(owned.json().book.id).toBe(kidsBook);
    // The adult copy exists, but for the kid it doesn't: the request goes through as usual.
    const locked = await ask("kid", { title: "Gone Girl" });
    expect(locked.statusCode).toBe(201);
    expect(JSON.stringify(locked.json())).not.toContain("already");
  });

  it("limits open requests per person", async () => {
    for (let i = 0; i < 20; i++) expect((await ask("adult", { title: `Book number ${i}` })).statusCode).toBe(201);
    expect((await ask("adult", { title: "One too many" })).statusCode).toBe(429);
  });
});

describe("approving", () => {
  it("lets a linked parent approve their kid's request", async () => {
    const id = (await ask("kid", { title: "Charlotte's Web" })).json().request.id;
    const approvals = await list("parent", "approvals");
    expect(approvals.json().items.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(approvals.json().items[0]).toMatchObject({ canApprove: true, requestedBy: { displayName: "Emma" } });
    expect((await f.app.inject({ url: "/api/requests/summary", headers: f.as("parent") })).json()).toEqual({ open: 0, toApprove: 1 });

    const res = await act("parent", id, "approve", "Enjoy!");
    expect(res.statusCode).toBe(200);
    // No downloader set up: it stays approved for an admin to fetch.
    expect(res.json()).toMatchObject({ status: "approved", decidedBy: { displayName: "Dad" }, note: "Enjoy!" });
  });

  it("hides other people's requests: kids, adults and unlinked parents get 404", async () => {
    // Leo is not Dad's kid.
    const [leo] = f.db.select().from(users).where(eq(users.id, f.ids.otherKid)).all();
    const [row] = f.db.insert(bookRequests).values({ requestedBy: leo!.id, title: "Matilda" }).returning().all();
    for (const who of ["parent", "adult", "kid"] as const) {
      expect((await f.app.inject({ url: `/api/requests/${row!.id}`, headers: f.as(who) })).statusCode).toBe(404);
      expect((await act(who, row!.id, "approve")).statusCode).toBe(404);
    }
    expect((await act("admin", row!.id, "approve")).statusCode).toBe(200);
  });

  it("doesn't let people approve their own requests (except admins)", async () => {
    const kidReq = (await ask("kid", { title: "Charlotte's Web" })).json().request.id;
    expect((await act("kid", kidReq, "approve")).statusCode).toBe(403);
    const adultReq = (await ask("adult", { title: "Gone Girl" })).json().request.id;
    expect((await act("adult", adultReq, "approve")).statusCode).toBe(403);
    // A parent's own request goes to an admin.
    const parentReq = (await ask("parent", { title: "Gone Girl" })).json().request.id;
    expect((await act("parent", parentReq, "approve")).statusCode).toBe(403);
    expect((await act("admin", parentReq, "approve")).json().status).toBe("approved");
  });

  it("won't let a parent approve a book above the kid's limit; an admin may get it for the library", async () => {
    const id = (await ask("kid", { title: "Fifty Shades of Grey" })).json().request.id;
    expect((await act("parent", id, "approve")).statusCode).toBe(409);
    expect((await act("admin", id, "approve")).json().status).toBe("approved");
  });

  it("declines with a note, and lets the requester withdraw a pending request", async () => {
    // Emma is 7: a teen book is declined on the spot.
    expect((await ask("kid", { title: "The Hunger Games" })).json().request.status).toBe("declined");
    const id = (await ask("kid", { title: "Some Book Nobody Knows" })).json().request.id;
    const d = await act("parent", id, "decline", "When you're 13");
    expect(d.json()).toMatchObject({ status: "declined", note: "When you're 13" });
    const mine = await list("kid");
    expect(mine.json().items.find((r: { id: string }) => r.id === id)).toMatchObject({ status: "declined", note: "When you're 13", canCancel: false });

    const other = (await ask("kid", { title: "Charlotte's Web" })).json().request.id;
    expect((await f.app.inject({ method: "DELETE", url: `/api/requests/${other}`, headers: f.as("kid") })).statusCode).toBe(204);
  });

  it("scope=all is admin-only", async () => {
    await ask("kid", { title: "Charlotte's Web" });
    expect((await list("parent", "all")).statusCode).toBe(403);
    expect((await list("admin", "all")).json().total).toBe(1);
  });
});

describe("request search", () => {
  it("marks books the reader can open as in the library, through the content lock", async () => {
    const adultBook = f.book("Gone Girl", "adult");
    const res = await f.app.inject({ url: "/api/requests/search?q=gone girl", headers: f.as("adult") });
    expect(res.statusCode).toBe(200);
    const hit = res.json().items.find((c: { title: string }) => c.title === "Gone Girl");
    expect(hit.inLibrary).toEqual({ id: adultBook });
  });

  it("shows kids only candidates rated within their limit, and never marks a locked book as owned", async () => {
    f.book("Fifty Shades of Grey", "explicit");
    const res = await f.app.inject({ url: "/api/requests/search?q=fifty shades charlotte gone hunger", headers: f.as("kid") });
    const titles = res.json().items.map((c: { title: string }) => c.title);
    expect(titles).toEqual(["Charlotte's Web"]);
    expect(res.json().hiddenForAge).toBe(3);
    expect(JSON.stringify(res.json())).not.toContain("Fifty");
  });
});
