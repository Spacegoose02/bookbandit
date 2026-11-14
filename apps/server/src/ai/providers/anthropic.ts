/**
 * Anthropic Messages API (Claude).
 *
 * Sampling settings (temperature, top_p, top_k) are never sent: current Claude models reject them
 * with a 400, and the API applies its own defaults. Moderation and rating ask for JSON in the
 * system prompt, so they do not depend on temperature 0.
 *
 * Anthropic has no embeddings API, so meaning search needs another provider (Ollama, OpenAI, Gemini).
 */
import { postJson, postSse, ProviderError, trimSlash, type AiProvider, type ChatRequest, type ChatResult, type FetchLike, type ProviderConfig } from "./types.js";

interface MessagesResponse {
  model?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

type StreamEvent =
  | { type: "message_start"; message?: { model?: string; usage?: { input_tokens?: number } } }
  | { type: "content_block_delta"; delta?: { type?: string; text?: string } }
  | { type: "message_delta"; usage?: { output_tokens?: number } }
  | { type: string };

export function anthropicProvider(config: ProviderConfig, fetchImpl: FetchLike): AiProvider {
  const base = trimSlash(config.baseUrl || "https://api.anthropic.com");
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (config.apiKey) headers["x-api-key"] = config.apiKey;
  const timeoutMs = config.timeoutMs ?? 120_000;
  const body = (req: ChatRequest, stream: boolean) => ({
    model: config.model,
    system: req.json ? `${req.system}\n\nReply with one JSON object and nothing else.` : req.system,
    messages: req.messages,
    // Current Claude models think before answering and that counts toward max_tokens, so short
    // answers (moderation, rating) get room for it. Only tokens actually used are billed.
    max_tokens: Math.max(req.maxTokens ?? 800, 1024),
    ...(stream ? { stream: true } : {}),
  });
  return {
    config,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const r = await postJson<MessagesResponse>(fetchImpl, `${base}/v1/messages`, {
        headers,
        body: body(req, false),
        timeoutMs,
        label: config.name,
      });
      return {
        text: (r.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("")
          .trim(),
        model: r.model ?? config.model,
        inputTokens: r.usage?.input_tokens,
        outputTokens: r.usage?.output_tokens,
      };
    },
    async chatStream(req, onDelta) {
      let text = "";
      let model = config.model;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      await postSse(fetchImpl, `${base}/v1/messages`, { headers, body: body(req, true), timeoutMs, label: config.name }, (e: StreamEvent & MessagesResponse) => {
        if (e.type === "message_start" && "message" in e) {
          model = e.message?.model ?? model;
          inputTokens = e.message?.usage?.input_tokens;
        } else if (e.type === "content_block_delta" && "delta" in e && e.delta?.type === "text_delta" && e.delta.text) {
          text += e.delta.text;
          onDelta(e.delta.text);
        } else if (e.type === "message_delta" && "usage" in e) {
          outputTokens = e.usage?.output_tokens ?? outputTokens;
        } else if (e.type === "message" && e.content) {
          // A proxy that ignored stream: true.
          const all = e.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
          text += all;
          if (all) onDelta(all);
        }
      });
      return { text: text.trim(), model, inputTokens, outputTokens };
    },
    async embed() {
      throw new ProviderError(`${config.name}: Claude has no embeddings API. Use Ollama (nomic-embed-text), OpenAI or Gemini for meaning search.`);
    },
    async listModels() {
      const r = await postJson<{ data?: { id: string }[] }>(fetchImpl, `${base}/v1/models?limit=100`, {
        headers,
        timeoutMs: 15_000,
        label: config.name,
      });
      return (r.data ?? []).map((m) => m.id);
    },
  };
}
