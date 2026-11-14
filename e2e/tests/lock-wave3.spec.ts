/** Wave 3 doors that take a book id: audio, chapter quizzes and word help. */
import { expect, test } from "@playwright/test";
import { bearer, world } from "../support/state.js";

const LOCKED = ["teen", "adult", "explicit", "unrated", "inbox"] as const;

test("audio routes are 404 for a kid on a locked book", async ({ request }) => {
  const w = world();
  const kid = bearer(w.emma.token);
  for (const k of LOCKED) {
    const id = w.books[k].id;
    for (const path of [`/api/books/${id}/audio`, `/api/books/${id}/audio/tracks/0`, `/api/books/${id}/audio/cover`, `/api/books/${id}/audio/progress`, `/api/books/${id}/audio/bookmarks`]) {
      expect((await request.get(path, { headers: kid })).status(), `${k}: GET ${path}`).toBe(404);
    }
    const put = await request.put(`/api/books/${id}/audio/progress`, { headers: kid, data: { position: 12, updatedAt: Date.now() } });
    expect([400, 404], `${k}: PUT audio progress`).toContain(put.status());
    expect(put.status(), `${k}: PUT audio progress must not be accepted`).not.toBe(200);
  }
});

test("a kid can't get a quiz or word help tied to a locked book", async ({ request }) => {
  const w = world();
  const kid = bearer(w.emma.token);
  for (const k of LOCKED) {
    const quiz = await request.post("/api/learning/quizzes", {
      headers: kid,
      data: { bookId: w.books[k].id, section: "The raccoon tiptoed past the shelves, counting spines and humming.", chapterLabel: "Chapter 1" },
    });
    expect(quiz.status(), `${k}: quiz`).toBe(404);
    const word = await request.get(`/api/learning/words/raccoon?bookId=${w.books[k].id}`, { headers: kid });
    expect(word.status(), `${k}: word help`).toBe(404);
  }
  // Control: word help on her own book is allowed.
  const ok = await request.get(`/api/learning/words/raccoon?bookId=${w.books.kids.id}`, { headers: kid });
  expect(ok.status()).not.toBe(404);
});
