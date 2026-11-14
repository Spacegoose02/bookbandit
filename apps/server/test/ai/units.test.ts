import { describe, expect, it } from "vitest";
import { makeProvider } from "../../src/ai/providers/index.js";
import { parseModeration, wordFilter } from "../../src/ai/moderation.js";
import { redactPersonalDetails, stripUnlistedLinks } from "../../src/ai/privacy.js";
import { hostAllowed } from "../../src/ai/search.js";
import { excerptUpTo, htmlToText } from "../../src/ai/booktext.js";
import { parseRatingReply } from "../../src/ai/rating.js";
import { searchTerms } from "../../src/ai/library-context.js";

function recorder(response: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

describe("providers", () => {
  const req = { system: "Be Barnaby", messages: [{ role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "hello" }, { role: "user" as const, content: "book?" }] };

  it("Anthropic: messages API with x-api-key and version header", async () => {
    const r = recorder({ model: "claude-haiku-5-5", content: [{ type: "text", text: "Hi!" }], usage: { input_tokens: 3, output_tokens: 1 } });
    const p = makeProvider({ id: "c", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5", apiKey: "k" }, r.fetchImpl);
    const out = await p.chat(req);
    expect(out).toEqual({ text: "Hi!", model: "claude-haiku-5-5", inputTokens: 3, outputTokens: 1 });
    expect(r.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const h = r.calls[0]!.init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("k");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(r.calls[0]!.init.body));
    expect(body).toMatchObject({ model: "claude-haiku-5-5", system: "Be Barnaby", messages: req.messages });
  });

  it("Anthropic: never sends sampling settings, which current Claude models reject", async () => {
    const r = recorder({ model: "claude-opus-5-5", content: [{ type: "text", text: "{}" }] });
    const p = makeProvider({ id: "c", name: "Claude", kind: "anthropic", model: "claude-opus-5-5", apiKey: "k" }, r.fetchImpl);
    await p.chat({ ...req, temperature: 0, json: true });
    await p.chat(req);
    for (const call of r.calls) {
      const body = JSON.parse(String(call.init.body));
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body).not.toHaveProperty("top_k");
      expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
    }
  });

  it("Gemini: generateContent with systemInstruction and model role", async () => {
    const r = recorder({ candidates: [{ content: { parts: [{ text: "Hey" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } });
    const p = makeProvider({ id: "g", name: "Gemini", kind: "gemini", model: "gemini-2.5-flash", apiKey: "gk" }, r.fetchImpl);
    const out = await p.chat({ ...req, json: true });
    expect(out.text).toBe("Hey");
    expect(r.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect((r.calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("gk");
    const body = JSON.parse(String(r.calls[0]!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe("Be Barnaby");
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("OpenAI-compatible: no auth header for a local server, bearer when a key is set", async () => {
    const r = recorder({ choices: [{ message: { content: "ok" } }] });
    await makeProvider({ id: "o", name: "Ollama", kind: "openai", baseUrl: "http://ollama:11434/v1/", model: "llama3.2" }, r.fetchImpl).chat(req);
    expect(r.calls[0]!.url).toBe("http://ollama:11434/v1/chat/completions");
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    await makeProvider({ id: "o", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-x", apiKey: "sk" }, r.fetchImpl).chat(req);
    expect((r.calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk");
  });

  it("reports upstream errors without leaking the key", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    const p = makeProvider({ id: "c", name: "Claude", kind: "anthropic", model: "m", apiKey: "sk-secret" }, fetchImpl);
    await expect(p.chat(req)).rejects.toThrow(/Claude: HTTP 401 \(bad key\)/);
    await expect(p.chat(req)).rejects.not.toThrow(/sk-secret/);
  });
});

describe("moderation", () => {
  it("parses JSON and Llama Guard replies, and fails closed on nonsense", () => {
    expect(parseModeration('{"flagged": false}')).toEqual({ flagged: false });
    expect(parseModeration('{"flagged": true, "category": "self_harm"}')).toMatchObject({ flagged: true, category: "self_harm" });
    expect(parseModeration("safe")).toEqual({ flagged: false });
    expect(parseModeration("unsafe\nS11")).toMatchObject({ flagged: true, category: "self_harm" });
    expect(parseModeration("I think it's fine?")).toMatchObject({ flagged: true });
  });

  it("word filter catches the obvious without flagging book titles", () => {
    expect(wordFilter("I want to kill myself").category).toBe("self_harm");
    expect(wordFilter("Moby Dick").flagged).toBe(false);
    expect(wordFilter("naked mole rats").flagged).toBe(false);
    expect(wordFilter("What is a volcano?").flagged).toBe(false);
  });
});

describe("privacy", () => {
  it("redacts personal details", () => {
    const r = redactPersonalDetails("Mail me at kid@example.com or call +1 (555) 123-4567, I live on Elm Road near the park");
    expect(r.text).not.toMatch(/kid@example|555|Elm Road/);
    expect(r.removed.sort()).toEqual(["address", "email", "phone"]);
    expect(redactPersonalDetails("I read 3 books in 2024!").removed).toEqual([]);
  });

  it("keeps only cited links", () => {
    expect(stripUnlistedLinks("see https://a.org/x and https://b.org", ["https://a.org/x"])).toBe("see https://a.org/x and [link removed]");
  });

  it("matches allowlisted hosts and subdomains only", () => {
    expect(hostAllowed("https://kids.britannica.com/x", ["kids.britannica.com"])).toBe(true);
    expect(hostAllowed("https://www.natgeokids.com/uk", ["natgeokids.com"])).toBe(true);
    expect(hostAllowed("https://evilnatgeokids.com", ["natgeokids.com"])).toBe(false);
    expect(hostAllowed("javascript:alert(1)", ["natgeokids.com"])).toBe(false);
  });
});

describe("book text", () => {
  it("strips markup and cuts at the position", () => {
    expect(htmlToText("<html><head><title>T</title><style>p{}</style></head><body><p>One &amp; two</p><p>Three</p></body></html>")).toBe("One & two\nThree");
    const ex = excerptUpTo("a".repeat(100) + "b".repeat(100), 0.5);
    expect(ex.recent).toBe("a".repeat(100));
    const long = excerptUpTo("x".repeat(50_000) + "END", 0.9, 10_000);
    expect(long.opening.length + long.recent.length).toBe(10_000);
    expect(long.recent).not.toContain("END");
  });
});

describe("helpers", () => {
  it("reads a rating suggestion", () => {
    expect(parseRatingReply('Sure: {"rating":"Middle Grade","confidence":0.8,"reasons":"school story"}')).toEqual({ rating: "middle_grade", confidence: 0.8, reasons: "school story" });
    expect(parseRatingReply('{"rating":"PG"}')).toBeNull();
  });

  it("pulls search terms from a question", () => {
    expect(searchTerms("Can you recommend a book about DRAGONS and space?")).toEqual(["dragons", "space"]);
  });
});
