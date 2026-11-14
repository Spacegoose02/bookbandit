import { join } from "node:path";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookFiles } from "../../src/db/schema.js";
import { baseForms, normalizeWord, syllables } from "../../src/learning/dictionary.js";
import { namesIn, offlineQuiz, parseQuiz } from "../../src/learning/quiz.js";
import { family, type Family } from "../helpers.js";
import { fakeAi, OLLAMA_SETTINGS } from "../ai/fake.js";
import { tempDir } from "../library/fixtures.js";
import { CHAPTER_ONE, makeStoryEpub } from "./fixtures.js";

let f: Family;
let dir: string;
let ai: ReturnType<typeof fakeAi>;
let kidsBook: string;
let adultBook: string;
let teenBook: string;

beforeEach(async () => {
  dir = await tempDir();
  ai = fakeAi();
  f = await family({ ai: { fetchImpl: ai.fetchImpl } }, { BOOKS_DIR: join(dir, "books"), CONFIG_DIR: join(dir, "config") });
  kidsBook = f.book("Pip and the Berry", "kids");
  adultBook = f.book("Grown-up Thriller", "adult");
  teenBook = f.book("Teen Book", "teen");
  await makeStoryEpub(join(dir, "books", "pip.epub"), [CHAPTER_ONE, "Too short."]);
  await makeStoryEpub(join(dir, "books", "adult.epub"), [CHAPTER_ONE]);
  await makeStoryEpub(join(dir, "books", "teen.epub"), [CHAPTER_ONE]);
  f.db.insert(bookFiles).values({ bookId: kidsBook, relPath: "pip.epub", format: "epub", sizeBytes: 1 }).run();
  f.db.insert(bookFiles).values({ bookId: adultBook, relPath: "adult.epub", format: "epub", sizeBytes: 1 }).run();
  f.db.insert(bookFiles).values({ bookId: teenBook, relPath: "teen.epub", format: "epub", sizeBytes: 1 }).run();
});

afterEach(async () => {
  await f.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (who: "admin" | "parent" | "adult" | "kid", method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) =>
  f.app.inject({ method, url, headers: f.as(who), payload });

const barnabyOn = async () => {
  await call("admin", "PUT", "/api/admin/ai/settings", OLLAMA_SETTINGS);
  await call("parent", "PUT", `/api/ai/kids/${f.ids.kid}/settings`, { enabled: true, webSearch: false, dailyLimit: 20 });
};

describe("word helpers", () => {
  it("normalises and finds base forms", () => {
    expect(normalizeWord("“Scampered,”")).toBe("scampered");
    expect(normalizeWord("Pip's")).toBe("pip");
    expect(normalizeWord("123")).toBeNull();
    expect(baseForms("scampered")).toContain("scamper");
    expect(baseForms("ponies")).toContain("pony");
    expect(baseForms("giggling")).toContain("giggle");
    expect(baseForms("hopped")).toContain("hop");
  });

  it("splits words into rough syllables", () => {
    expect(syllables("adventure").join("")).toBe("adventure");
    expect(syllables("adventure").length).toBeGreaterThan(1);
    expect(syllables("time")).toEqual(["time"]);
    expect(syllables("cat")).toEqual(["cat"]);
  });
});

describe("word help", () => {
  it("answers from the built-in kid dictionary, offline, and logs the lookup", async () => {
    const res = await call("kid", "GET", `/api/learning/words/Scampered?bookId=${kidsBook}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ word: "scampered", headword: "scamper", source: "dictionary" });
    expect(res.json().meaning).toMatch(/quick little steps/);
    expect(ai.calls).toHaveLength(0);
  });

  it("uses the admin's dictionary file", async () => {
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "config", "dictionary.json"), JSON.stringify({ thistledown: "The soft fluffy seeds of a thistle." }));
    expect((await call("kid", "GET", "/api/learning/words/thistledown")).json()).toMatchObject({ source: "dictionary", meaning: "The soft fluffy seeds of a thistle." });
  });

  it("prefers a parent's own meaning; kids can't write meanings", async () => {
    expect((await call("kid", "PUT", "/api/learning/words/meadow", { meaning: "lol" })).statusCode).toBe(403);
    expect((await call("parent", "PUT", "/api/learning/words/meadow", { meaning: "The big field behind Grandma's house." })).statusCode).toBe(200);
    expect((await call("kid", "GET", "/api/learning/words/meadows")).json()).toMatchObject({ source: "family", meaning: "The big field behind Grandma's house." });
  });

  it("asks Barnaby for unknown words only when a parent turned him on, then remembers the answer", async () => {
    expect((await call("kid", "GET", "/api/learning/words/thistledown")).json()).toMatchObject({ source: "none", meaning: null });
    expect(ai.chatCalls()).toHaveLength(0);

    await barnabyOn();
    ai.setChat(() => '{"meaning":"The soft, fluffy seeds of a thistle plant.","example":"The thistledown floated away."}');
    const res = (await call("kid", "GET", `/api/learning/words/thistledown?bookId=${kidsBook}&context=${encodeURIComponent("a warm blanket made of thistledown")}`)).json();
    expect(res).toMatchObject({ source: "ai", meaning: "The soft, fluffy seeds of a thistle plant." });
    expect(ai.chatCalls().at(-1)!.body.messages.at(-1).content).toContain("a warm blanket made of thistledown");
    expect(ai.modCalls().length).toBeGreaterThan(0); // the kid's answer went through moderation

    const before = ai.chatCalls().length;
    expect((await call("kid", "GET", "/api/learning/words/thistledown")).json().source).toBe("ai");
    expect(ai.chatCalls()).toHaveLength(before);
    // Parents can see and correct Barnaby's meanings.
    expect((await call("parent", "GET", "/api/learning/words")).json().map((w: { word: string }) => w.word)).toContain("thistledown");
  });

  it("drops Barnaby's answer when moderation flags it", async () => {
    await barnabyOn();
    ai.setChat(() => '{"meaning":"something awful","example":""}');
    ai.setModeration(() => '{"flagged": true, "category": "violence"}');
    expect((await call("kid", "GET", "/api/learning/words/zorblax")).json()).toMatchObject({ source: "none", meaning: null });
  });

  it("404s a lookup tied to a locked book (content lock)", async () => {
    expect((await call("kid", "GET", `/api/learning/words/meadow?bookId=${adultBook}`)).statusCode).toBe(404);
  });
});

describe("quiz generation", () => {
  it("finds names and makes three offline questions", () => {
    expect(namesIn(CHAPTER_ONE)[0]).toBe("Pip");
    const qs = offlineQuiz(CHAPTER_ONE, "seed")!;
    expect(qs).toHaveLength(3);
    expect(qs[0]!.q).toMatch(/Who/);
    expect(qs[0]!.choices[qs[0]!.answer]).toBe("Pip");
    for (const q of qs) {
      expect(q.choices).toHaveLength(3);
      expect(new Set(q.choices).size).toBe(3);
    }
    expect(offlineQuiz("Too short.", "x")).toBeNull();
  });

  it("only accepts a model reply of exactly the right shape", () => {
    const good = { questions: [0, 1, 2].map((i) => ({ q: `Q${i}?`, choices: ["a", "b", "c"], answer: i })) };
    expect(parseQuiz(`Sure! ${JSON.stringify(good)}`)).toHaveLength(3);
    expect(parseQuiz(JSON.stringify({ questions: [{ q: "x", choices: ["a"], answer: 0 }] }))).toBeNull();
    expect(parseQuiz(JSON.stringify({ questions: good.questions.map((q) => ({ ...q, answer: 5 })) }))).toBeNull();
  });
});

describe("quizzes", () => {
  const section = "OEBPS/text/c0.xhtml";

  it("makes a quiz from the chapter, cheers each answer, and shows it to the parent", async () => {
    const res = await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section, chapterLabel: "Chapter 1" });
    expect(res.statusCode).toBe(200);
    const quiz = res.json();
    expect(quiz).toMatchObject({ source: "offline", chapterLabel: "Chapter 1", completedAt: null });
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.questions[0].answer).toBeNull(); // not given away before answering

    // Same chapter again the same day: the same quiz.
    expect((await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section })).json().id).toBe(quiz.id);

    const answers = [];
    for (let i = 0; i < 3; i++) {
      answers.push((await call("kid", "POST", `/api/learning/quizzes/${quiz.id}/answer`, { question: i, choice: 0 })).json());
    }
    expect(answers[0].cheer).toBeTruthy();
    expect(answers[2]).toMatchObject({ done: true });
    expect(answers[2].finalCheer).toMatch(/out of 3/);
    const score = answers.filter((a) => a.correct).length;

    // A second try doesn't change the first answer.
    const retry = (await call("kid", "POST", `/api/learning/quizzes/${quiz.id}/answer`, { question: 0, choice: 1 })).json();
    expect(retry.correct).toBe(answers[0].correct);

    const summary = await call("parent", "GET", `/api/learning/kids/${f.ids.kid}`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().stats).toMatchObject({ quizzes: 1, correct: score, questions: 3 });
    expect(summary.json().quizzes[0]).toMatchObject({ bookTitle: "Pip and the Berry", score });
  });

  it("uses Barnaby's questions when he's on for the kid", async () => {
    await barnabyOn();
    const qs = [0, 1, 2].map((i) => ({ q: `What did Pip find ${i}?`, choices: ["A berry", "A shoe", "A hat"], answer: 0 }));
    ai.setChat(() => JSON.stringify({ questions: qs }));
    const quiz = (await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section })).json();
    expect(quiz.source).toBe("ai");
    expect(quiz.questions[0].q).toBe("What did Pip find 0?");
    expect(ai.lastSystem()).toMatch(/[78]-year-old/);
  });

  it("falls back to offline questions when the model's answer is junk", async () => {
    await barnabyOn();
    ai.setChat(() => "I don't know");
    expect((await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section })).json().source).toBe("offline");
  });

  it("says when a chapter is too short, and 404s sections that aren't in the book", async () => {
    expect((await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section: "OEBPS/text/c1.xhtml" })).statusCode).toBe(422);
    expect((await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section: "META-INF/container.xml" })).statusCode).toBe(404);
  });

  it("404s quizzes on locked books, and other people's quizzes", async () => {
    expect((await call("kid", "POST", "/api/learning/quizzes", { bookId: adultBook, section })).statusCode).toBe(404);
    const quiz = (await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section })).json();
    expect((await call("adult", "POST", `/api/learning/quizzes/${quiz.id}/answer`, { question: 0, choice: 0 })).statusCode).toBe(404);
  });

  it("parent summary: linked parent and admin only, and filtered by what the parent may see", async () => {
    await call("kid", "POST", "/api/learning/quizzes", { bookId: kidsBook, section });
    expect((await call("adult", "GET", `/api/learning/kids/${f.ids.kid}`)).statusCode).toBe(404);
    expect((await call("admin", "GET", `/api/learning/kids/${f.ids.kid}`)).statusCode).toBe(200);
    expect((await call("parent", "GET", `/api/learning/kids/${f.ids.otherKid}`)).statusCode).toBe(404);
    expect((await call("kid", "GET", "/api/learning/kids/me")).statusCode).toBe(200);
  });
});
