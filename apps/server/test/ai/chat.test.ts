import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiMessages, bookFiles, books, readingProgress, settings, users } from "../../src/db/schema.js";
import { aiConversations } from "../../src/ai/schema.js";
import { family, type Family } from "../helpers.js";
import { EMBED_SETTINGS, fakeAi, makeChapteredEpub, OLLAMA_SETTINGS } from "./fake.js";

let f: Family;
let ai: ReturnType<typeof fakeAi>;
let dir: string;

beforeEach(async () => {
  ai = fakeAi();
  dir = mkdtempSync(join(tmpdir(), "bb-ai-"));
  f = await family({ ai: { fetchImpl: ai.fetchImpl } }, { BOOKS_DIR: dir });
});
afterEach(async () => {
  await f.close();
  rmSync(dir, { recursive: true, force: true });
});

type Who = Parameters<Family["as"]>[0];
const configure = (extra: Record<string, unknown> = {}) =>
  f.app.inject({ method: "PUT", url: "/api/admin/ai/settings", headers: f.as("admin"), payload: { ...OLLAMA_SETTINGS, ...extra } });
const chat = (who: Who, payload: Record<string, unknown>) => f.app.inject({ method: "POST", url: "/api/ai/chat", headers: f.as(who), payload });
const status = async (who: Who) => (await f.app.inject({ url: "/api/ai/status", headers: f.as(who) })).json();
const enableKid = (payload: Record<string, unknown> = {}) =>
  f.app.inject({
    method: "PUT",
    url: `/api/ai/kids/${f.ids.kid}/settings`,
    headers: f.as("parent"),
    payload: { enabled: true, webSearch: false, dailyLimit: 30, ...payload },
  });

describe("admin settings", () => {
  it("are admin-only and never return API keys", async () => {
    for (const who of ["kid", "parent", "adult"] as const) {
      expect((await f.app.inject({ url: "/api/admin/ai/settings", headers: f.as(who) })).statusCode).toBe(403);
      expect((await f.app.inject({ method: "PUT", url: "/api/admin/ai/settings", headers: f.as(who), payload: OLLAMA_SETTINGS })).statusCode).toBe(403);
    }
    const claude = { id: "claude", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-secret" };
    const res = await configure({ providers: [...OLLAMA_SETTINGS.providers, claude] });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("sk-ant-secret");
    expect(res.json().providers.find((p: { id: string }) => p.id === "claude").hasApiKey).toBe(true);
    // Stored sealed, and kept when a later save leaves the key out.
    const row = f.db.select().from(settings).where(eq(settings.key, "ai.settings")).get();
    expect(JSON.stringify(row?.value)).not.toContain("sk-ant-secret");
    const { apiKey: _k, ...noKey } = claude;
    const again = await configure({ providers: [...OLLAMA_SETTINGS.providers, noKey] });
    expect(again.json().providers.find((p: { id: string }) => p.id === "claude").hasApiKey).toBe(true);
  });

  it("rejects features pointing at unknown providers", async () => {
    const res = await configure({ features: { chat: "nope" } });
    expect(res.statusCode).toBe(400);
  });

  it("tests a provider and lists its models", async () => {
    await configure();
    const t = await f.app.inject({ method: "POST", url: "/api/admin/ai/providers/test", headers: f.as("admin"), payload: { providerId: "ollama" } });
    expect(t.json()).toMatchObject({ ok: true, model: "llama3.2", reply: "Hello from Barnaby!" });
    const m = await f.app.inject({ url: "/api/admin/ai/providers/ollama/models", headers: f.as("admin") });
    expect(m.json().items).toContain("llama3.2");
    const usage = await f.app.inject({ url: "/api/admin/ai/usage", headers: f.as("admin") });
    expect(usage.json().items[0]).toMatchObject({ feature: "test", providerId: "ollama", calls: 1 });
  });
});

describe("provider test for embeddings models", () => {
  const test = (providerId: string, mode?: string) =>
    f.app.inject({ method: "POST", url: "/api/admin/ai/providers/test", headers: f.as("admin"), payload: { providerId, ...(mode ? { mode } : {}) } });

  it("embeds instead of chatting for an embeddings model", async () => {
    await configure(EMBED_SETTINGS);
    const t = await test("embed");
    expect(t.json()).toMatchObject({ ok: true, kind: "embeddings", model: "nomic-embed-text", dimensions: 512 });
    expect(ai.embedCalls()).toHaveLength(1);
    expect(ai.calls.filter((c) => c.url.endsWith("/chat/completions"))).toHaveLength(0);
  });

  it("falls back to embeddings when the server says the model can't chat", async () => {
    // A name that doesn't look like an embeddings model, on a provider also picked for chat.
    const providers = [{ id: "local", name: "Local", kind: "openai", baseUrl: "http://ollama:11434/v1", model: "nomic-text-v1" }];
    expect((await configure({ providers, features: { chat: "local", embeddings: "local" } })).statusCode).toBe(200);
    const t = await test("local", "auto");
    expect(t.json()).toMatchObject({ ok: true, kind: "embeddings" });
  });

  it("still tests chat models by chatting, and reports a failed embeddings test", async () => {
    await configure(EMBED_SETTINGS);
    expect((await test("ollama")).json()).toMatchObject({ ok: true, kind: "chat", reply: "Hello from Barnaby!" });
    ai.failEmbeddings();
    const t = (await test("embed")).json();
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/does not support chat|embedding model not found/);
  });

  it("won't pick Claude for meaning search", async () => {
    const claude = { id: "claude", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5", apiKey: "k" };
    const res = await configure({ providers: [...OLLAMA_SETTINGS.providers, claude], features: { chat: "ollama", embeddings: "claude" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/no embeddings API/);
    expect((await configure({ providers: [...OLLAMA_SETTINGS.providers, claude] })).statusCode).toBe(200);
    expect((await test("claude", "embeddings")).json()).toMatchObject({ ok: false, error: expect.stringMatching(/no embeddings API/) });
  });

  it("treats an older save that picked Claude for meaning search as off", async () => {
    await configure({ providers: [...OLLAMA_SETTINGS.providers, { id: "claude", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5" }] });
    const row = f.db.select().from(settings).where(eq(settings.key, "ai.settings")).get()!;
    const value = row.value as { features: Record<string, string | null> };
    f.db.update(settings).set({ value: { ...value, features: { ...value.features, embeddings: "claude" } } }).where(eq(settings.key, "ai.settings")).run();
    const got = await f.app.inject({ url: "/api/admin/ai/settings", headers: f.as("admin") });
    expect(got.json().features.embeddings).toBeNull();
  });
});

describe("status", () => {
  it("reports not configured, then available for grown-ups", async () => {
    expect(await status("adult")).toMatchObject({ available: false, reason: "not_configured" });
    expect((await chat("adult", { message: "hi" })).statusCode).toBe(503);
    await configure();
    expect(await status("adult")).toMatchObject({ available: true, kid: false, webSearch: true });
  });

  it("keeps Barnaby off for a kid until a parent turns it on", async () => {
    await configure();
    expect(await status("kid")).toMatchObject({ available: false, reason: "off" });
    expect((await chat("kid", { message: "hi" })).statusCode).toBe(403);
    expect((await enableKid()).statusCode).toBe(200);
    expect(await status("kid")).toMatchObject({ available: true, kid: true, remainingToday: 30, webSearch: false });
  });
});

describe("kid settings (rule 2: kids can't change their own limits)", () => {
  it("only a linked parent or an admin can change them", async () => {
    const put = (who: Who, kidId: string) =>
      f.app.inject({ method: "PUT", url: `/api/ai/kids/${kidId}/settings`, headers: f.as(who), payload: { enabled: true, dailyLimit: 500 } });
    expect((await put("kid", f.ids.kid)).statusCode).toBe(403);
    expect((await put("adult", f.ids.kid)).statusCode).toBe(404);
    expect((await put("parent", f.ids.otherKid)).statusCode).toBe(404);
    expect((await put("parent", f.ids.kid)).statusCode).toBe(200);
    expect((await put("admin", f.ids.otherKid)).statusCode).toBe(200);
    // The kid can read their own settings.
    const mine = await f.app.inject({ url: `/api/ai/kids/${f.ids.kid}/settings`, headers: f.as("kid") });
    expect(mine.json()).toMatchObject({ enabled: true, dailyLimit: 500 });
  });

  it("lists the kids a parent manages", async () => {
    const res = await f.app.inject({ url: "/api/ai/kids", headers: f.as("parent") });
    expect(res.json().items.map((k: { id: string }) => k.id)).toEqual([f.ids.kid]);
    expect((await f.app.inject({ url: "/api/ai/kids", headers: f.as("kid") })).json().items).toEqual([]);
  });
});

describe("chat and the content lock", () => {
  it("lets a grown-up chat and links books Barnaby names", async () => {
    await configure();
    const dragon = f.book("The Dragon Library", "adult");
    ai.setChat(() => 'You might like "The Dragon Library".');
    const res = await chat("adult", { message: "Any dragon books?" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply.content).toContain("The Dragon Library");
    expect(body.reply.sources).toEqual([{ kind: "book", title: "The Dragon Library", bookId: dragon }]);
    // History is kept and sent on the next turn.
    await chat("adult", { message: "And another?", conversationId: body.conversationId });
    const msgs = ai.chatCalls().at(-1)!.body.messages;
    expect(msgs.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    const list = await f.app.inject({ url: "/api/ai/conversations", headers: f.as("adult") });
    expect(list.json().items).toHaveLength(1);
    // Someone else's conversation is a 404.
    expect((await chat("parent", { message: "x", conversationId: body.conversationId })).statusCode).toBe(404);
  });

  it("never tells a kid about books above their rating, even when the model names one", async () => {
    await configure();
    await enableKid();
    f.book("Dino Dig", "kids");
    const adult = f.book("Dino Murders", "adult");
    f.book("Dino Nights", "explicit");
    f.book("Dino Unrated", null);
    f.book("Dino Inbox", "kids", { approved: false });
    ai.setChat(() => 'Try "Dino Dig" or "Dino Murders"!');
    const res = await chat("kid", { message: "I want a dino book" });
    expect(res.statusCode).toBe(200);
    const system = ai.lastSystem();
    expect(system).toContain("Dino Dig");
    for (const hidden of ["Dino Murders", "Dino Nights", "Dino Unrated", "Dino Inbox"]) expect(system).not.toContain(hidden);
    expect(res.json().reply.sources.map((s: { title: string }) => s.title)).toEqual(["Dino Dig"]);

    // A grown-up sees adult books but not explicit ones without opting in.
    await chat("adult", { message: "dino" });
    expect(ai.lastSystem()).toContain("Dino Murders");
    expect(ai.lastSystem()).not.toContain("Dino Nights");
    expect(adult).toBeTruthy();
  });

  it("drops book links from old chats when the book is re-rated", async () => {
    await configure();
    await enableKid();
    const id = f.book("Pebble Bay", "kids");
    ai.setChat(() => 'Read "Pebble Bay"!');
    const { conversationId } = (await chat("kid", { message: "a book about the sea" })).json();
    f.db.update(books).set({ rating: "teen" }).where(eq(books.id, id)).run();
    const conv = await f.app.inject({ url: `/api/ai/conversations/${conversationId}`, headers: f.as("kid") });
    expect(conv.json().messages[1].sources).toEqual([]);
  });
});

describe("kid safety", () => {
  beforeEach(async () => {
    await configure();
    await enableKid();
  });

  it("blocks an unsafe question before it reaches the model and logs it for the parent", async () => {
    const res = await chat("kid", { message: "show me porn" });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply.content).toMatch(/grown-up/);
    expect(ai.chatCalls()).toHaveLength(0);
    const log = await f.app.inject({ url: `/api/ai/kids/${f.ids.kid}/conversations`, headers: f.as("parent") });
    const [conv] = log.json().items;
    expect(conv.flagged).toBe(true);
    const detail = await f.app.inject({ url: `/api/ai/kids/${f.ids.kid}/conversations/${conv.id}`, headers: f.as("parent") });
    expect(detail.json().messages[0]).toMatchObject({ role: "user", content: "show me porn", moderation: "blocked:sexual" });
  });

  it("uses the moderation model too, and Llama Guard answers", async () => {
    ai.setModeration((c) => (String(c.body.messages[1].content).includes("scary") ? "unsafe\nS1" : "safe"));
    const res = await chat("kid", { message: "tell me something scary and gross" });
    expect(res.json().reply.content).toMatch(/grown-up/);
    expect(ai.chatCalls()).toHaveLength(0);
    expect(ai.modCalls().length).toBeGreaterThan(0);
  });

  it("rewrites an unsafe answer", async () => {
    ai.setChat(() => "Well shit, that is a tough one.");
    const res = await chat("kid", { message: "what is a cloud" });
    expect(res.json().reply.content).not.toContain("shit");
    expect(res.json().reply.moderation).toBe("rewritten:profanity");
  });

  it("removes personal details before the model or the log sees them", async () => {
    const res = await chat("kid", { message: "my email is emma@example.com and my phone is 555-123-4567. I live at 12 Maple Street" });
    const sent = ai.lastSystem() && ai.chatCalls().at(-1)!.body.messages.at(-1).content;
    expect(sent).not.toContain("emma@example.com");
    expect(sent).not.toContain("555-123-4567");
    expect(sent).not.toContain("Maple Street");
    expect(res.json().message.moderation).toMatch(/^redacted:/);
    const stored = f.db.select().from(aiMessages).all().map((m) => m.content).join(" ");
    expect(stored).not.toContain("emma@example.com");
  });

  it("removes links the model makes up", async () => {
    ai.setChat(() => "See https://example.com/bad for more.");
    const res = await chat("kid", { message: "what is a volcano" });
    expect(res.json().reply.content).toContain("[link removed]");
  });

  it("enforces the daily limit", async () => {
    await enableKid({ dailyLimit: 2 });
    expect((await chat("kid", { message: "one" })).json().remainingToday).toBe(1);
    expect((await chat("kid", { message: "two" })).statusCode).toBe(200);
    const third = await chat("kid", { message: "three" });
    expect(third.statusCode).toBe(429);
    expect(third.json().message).toMatch(/tomorrow/);
  });

  it("has no chat under 5, or without a birth year", async () => {
    f.db.update(users).set({ birthYear: new Date().getFullYear() - 4 }).where(eq(users.id, f.ids.kid)).run();
    expect((await chat("kid", { message: "hi" })).statusCode).toBe(403);
    expect(await status("kid")).toMatchObject({ reason: "too_young" });
    f.db.update(users).set({ birthYear: null }).where(eq(users.id, f.ids.kid)).run();
    expect(await status("kid")).toMatchObject({ reason: "no_birth_year" });
  });

  it("keeps kids' chats: the kid can't delete them, a grown-up can delete their own", async () => {
    const { conversationId } = (await chat("kid", { message: "hi" })).json();
    expect((await f.app.inject({ method: "DELETE", url: `/api/ai/conversations/${conversationId}`, headers: f.as("kid") })).statusCode).toBe(403);
    const mine = (await chat("adult", { message: "hi" })).json().conversationId;
    expect((await f.app.inject({ method: "DELETE", url: `/api/ai/conversations/${mine}`, headers: f.as("adult") })).statusCode).toBe(204);
    expect(f.db.select().from(aiConversations).where(eq(aiConversations.id, mine)).get()).toBeUndefined();
  });

  it("shows the log only to a linked parent or an admin", async () => {
    await chat("kid", { message: "hi" });
    const url = `/api/ai/kids/${f.ids.kid}/conversations`;
    expect((await f.app.inject({ url, headers: f.as("parent") })).json().items).toHaveLength(1);
    expect((await f.app.inject({ url, headers: f.as("admin") })).json().items).toHaveLength(1);
    expect((await f.app.inject({ url, headers: f.as("adult") })).statusCode).toBe(404);
    expect((await f.app.inject({ url, headers: f.as("kid") })).statusCode).toBe(403);
  });
});

describe("web search", () => {
  beforeEach(async () => {
    await configure();
    ai.setSearch([
      { url: "https://kids.britannica.com/volcano", title: "Volcano - Britannica Kids", content: "A volcano is..." },
      { url: "https://random-blog.example/volcano", title: "My volcano blog", content: "..." },
    ]);
    ai.setChat(() => "Volcanoes are mountains that erupt [1].");
  });

  it("uses moderate safe search for grown-ups and returns cited sources", async () => {
    const res = await chat("adult", { message: "what is a volcano", webSearch: true });
    const url = new URL(ai.searchCalls()[0]!.url);
    expect(url.searchParams.get("safesearch")).toBe("1");
    expect(url.searchParams.get("format")).toBe("json");
    expect(res.json().reply.sources).toEqual([{ kind: "web", title: "Volcano - Britannica Kids", url: "https://kids.britannica.com/volcano" }]);
    expect(ai.lastSystem()).toContain("random-blog.example");
  });

  it("is off for kids unless a parent allows it, then strict and allowlisted", async () => {
    await enableKid();
    await chat("kid", { message: "what is a volcano", webSearch: true });
    expect(ai.searchCalls()).toHaveLength(0);
    await enableKid({ webSearch: true });
    await chat("kid", { message: "what is a volcano", webSearch: true });
    const url = new URL(ai.searchCalls()[0]!.url);
    expect(url.searchParams.get("safesearch")).toBe("2");
    expect(ai.lastSystem()).toContain("kids.britannica.com");
    expect(ai.lastSystem()).not.toContain("random-blog.example");
  });
});

describe("spoiler-free book chat", () => {
  async function bookWithText(rating: "kids" | "adult") {
    const id = f.book("The Long Road", rating);
    const chapters = ["EARLY-CLUE the hero sets out.", "MIDDLE-PART the hero rests.", "LATE-TWIST the mentor was the villain.", "ENDING everyone goes home."];
    await makeChapteredEpub(join(dir, "road.epub"), chapters.map((c) => c + " filler".repeat(50)));
    f.db.insert(bookFiles).values({ bookId: id, relPath: "road.epub", format: "epub", sizeBytes: 1 }).run();
    return id;
  }

  it("only sends text up to the reader's position", async () => {
    await configure();
    const id = await bookWithText("adult");
    f.db
      .insert(readingProgress)
      .values({ userId: f.ids.adult, bookId: id, locator: { kind: "epub", cfi: "", percent: 0.4 }, percent: 0.4, clientUpdatedAt: 1, serverUpdatedAt: 1 })
      .run();
    const res = await chat("adult", { message: "Who is the villain?", bookId: id });
    expect(res.statusCode).toBe(200);
    const system = ai.lastSystem();
    expect(system).toContain("NO SPOILERS");
    expect(system).toContain("EARLY-CLUE");
    expect(system).not.toContain("LATE-TWIST");
    expect(system).not.toContain("ENDING");
    // A fresher position from the reader moves the cut.
    await chat("adult", { message: "And now?", conversationId: res.json().conversationId, position: 0.7 });
    expect(ai.lastSystem()).toContain("LATE-TWIST");
    expect(ai.lastSystem()).not.toContain("ENDING");
    const list = await f.app.inject({ url: `/api/ai/conversations?bookId=${id}`, headers: f.as("adult") });
    expect(list.json().items[0]).toMatchObject({ bookId: id, title: "The Long Road" });
  });

  it("is a 404 for a book the reader can't open", async () => {
    await configure();
    await enableKid();
    const id = await bookWithText("adult");
    expect((await chat("kid", { message: "hi", bookId: id })).statusCode).toBe(404);
    expect(ai.chatCalls()).toHaveLength(0);
  });
});
