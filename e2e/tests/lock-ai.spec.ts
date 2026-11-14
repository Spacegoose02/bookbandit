/** Barnaby: what reaches the model for a kid, and what comes back. */
import { expect, test } from "@playwright/test";
import { BOOKS, KID_LOCKED } from "../support/library.js";
import { bearer, world } from "../support/state.js";

const lockedTitles = KID_LOCKED.map((k) => BOOKS[k].title);

async function modelCalls(request: import("@playwright/test").APIRequestContext) {
  return JSON.stringify(await (await request.get(`${world().aiURL}/__calls`)).json());
}

test("a kid's chat never puts a locked book in front of the model", async ({ request }) => {
  const w = world();
  await request.delete(`${w.aiURL}/__calls`);
  const ask = `Tell me about ${lockedTitles.join(", ")} and also ${BOOKS.kids.title}. What should I read?`;
  const res = await request.post("/api/ai/chat", { headers: bearer(w.emma.token), data: { message: ask } });
  expect(res.status(), await res.text()).toBe(200);
  const reply = JSON.stringify(await res.json());

  // The model only ever saw her books (the question is hers, so only check the library part).
  const calls = JSON.parse(await modelCalls(request)) as { body: { messages: { role: string; content: string }[] } }[];
  expect(calls.length).toBeGreaterThan(0);
  const systems = calls.flatMap((c) => c.body.messages.filter((m) => m.role === "system").map((m) => m.content)).join("\n");
  for (const t of lockedTitles) expect(systems, `system prompt names "${t}"`).not.toContain(t);
  expect(systems).toContain(BOOKS.kids.title);
  // Book links in the reply only point at books she can open.
  for (const k of KID_LOCKED) expect(reply).not.toContain(w.books[k].id);
});

test("control: a parent's chat does include adult books", async ({ request }) => {
  const w = world();
  await request.delete(`${w.aiURL}/__calls`);
  const res = await request.post("/api/ai/chat", { headers: bearer(w.dad.token), data: { message: `Is ${BOOKS.adult.title} any good?` } });
  expect(res.status(), await res.text()).toBe(200);
  expect(await modelCalls(request)).toContain(BOOKS.adult.title);
});

test("a kid can't chat about a locked book", async ({ request }) => {
  const w = world();
  for (const k of ["adult", "explicit", "unrated"] as const) {
    const res = await request.post("/api/ai/chat", { headers: bearer(w.emma.token), data: { message: "What happens next?", bookId: w.books[k].id } });
    expect(res.status(), k).toBe(404);
  }
});

test("More like this never suggests a locked book to a kid, and is 404 on one", async ({ request }) => {
  const w = world();
  const res = await request.get(`/api/ai/books/${w.books.kids.id}/similar`, { headers: bearer(w.emma.token) });
  expect(res.status(), await res.text()).toBe(200);
  const body = JSON.stringify(await res.json());
  for (const k of KID_LOCKED) expect(body).not.toContain(w.books[k].id);
  for (const k of ["adult", "explicit", "unrated", "inbox"] as const) {
    const locked = await request.get(`/api/ai/books/${w.books[k].id}/similar`, { headers: bearer(w.emma.token) });
    expect(locked.status(), k).toBe(404);
  }
});
