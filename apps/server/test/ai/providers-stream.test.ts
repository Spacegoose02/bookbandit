import { describe, expect, it } from "vitest";
import { makeProvider } from "../../src/ai/providers/index.js";

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });

describe("streaming providers", () => {
  it("Anthropic: text deltas, model and usage; never sends temperature", async () => {
    let body: any;
    const p = makeProvider({ id: "c", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5", apiKey: "k" }, async (_u, init) => {
      body = JSON.parse(String(init!.body));
      return sse([
        { type: "message_start", message: { model: "claude-haiku-5-5", usage: { input_tokens: 12 } } },
        { type: "content_block_start", index: 0 },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "lo!" } },
        { type: "message_delta", usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    });
    const parts: string[] = [];
    const r = await p.chatStream({ system: "s", messages: [{ role: "user", content: "hi" }], temperature: 0.2 }, (t) => parts.push(t));
    expect(parts).toEqual(["Hel", "lo!"]);
    expect(r).toEqual({ text: "Hello!", model: "claude-haiku-5-5", inputTokens: 12, outputTokens: 3 });
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("temperature");
  });

  it("Gemini: streamGenerateContent with alt=sse", async () => {
    let url = "";
    const p = makeProvider({ id: "g", name: "Gemini", kind: "gemini", model: "gemini-2.5-flash", apiKey: "k" }, async (u) => {
      url = u;
      return sse([
        { candidates: [{ content: { parts: [{ text: "One " }] } }] },
        { candidates: [{ content: { parts: [{ text: "two" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }, modelVersion: "gemini-2.5-flash" },
      ]);
    });
    const parts: string[] = [];
    const r = await p.chatStream({ system: "s", messages: [{ role: "user", content: "hi" }] }, (t) => parts.push(t));
    expect(url).toContain(":streamGenerateContent?alt=sse");
    expect(parts.join("")).toBe("One two");
    expect(r).toMatchObject({ text: "One two", inputTokens: 4, outputTokens: 2 });
  });

  it("OpenAI-compatible server that ignores stream: true still answers", async () => {
    const p = makeProvider({ id: "o", name: "Old server", kind: "openai", baseUrl: "http://x/v1", model: "m" }, async () =>
      new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "Whole answer" } }] }), { headers: { "content-type": "application/json" } }),
    );
    const parts: string[] = [];
    const r = await p.chatStream({ system: "s", messages: [{ role: "user", content: "hi" }] }, (t) => parts.push(t));
    expect(parts).toEqual(["Whole answer"]);
    expect(r.text).toBe("Whole answer");
  });

  it("embeddings: Gemini batches, Claude says it has none", async () => {
    const g = makeProvider({ id: "g", name: "Gemini", kind: "gemini", model: "text-embedding-004", apiKey: "k" }, async (u, init) => {
      expect(u).toContain("text-embedding-004:batchEmbedContents");
      const n = JSON.parse(String(init!.body)).requests.length;
      return new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => ({ values: [1, 0] })) }));
    });
    expect((await g.embed(["a", "b"])).vectors).toEqual([[1, 0], [1, 0]]);
    const c = makeProvider({ id: "c", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5" }, async () => new Response("{}"));
    await expect(c.embed(["a"])).rejects.toThrow(/no embeddings API/);
  });
});
