/**
 * Anthropic Messages API (Claude).
 *
 * Sampling settings (temperature, top_p, top_k) are never sent: current Claude models reject them
 * with a 400, and the API applies its own defaults. Moderation and rating ask for JSON in the
 * system prompt, so they do not depend on temperature 0.
 */
import { postJson, trimSlash, type AiProvider, type ChatRequest, type ChatResult, type FetchLike, type ProviderConfig } from "./types.js";

interface MessagesResponse {
  model?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function anthropicProvider(config: ProviderConfig, fetchImpl: FetchLike): AiProvider {
  const base = trimSlash(config.baseUrl || "https://api.anthropic.com");
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (config.apiKey) headers["x-api-key"] = config.apiKey;
  const timeoutMs = config.timeoutMs ?? 120_000;
  return {
    config,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const system = req.json ? `${req.system}\n\nReply with one JSON object and nothing else.` : req.system;
      const r = await postJson<MessagesResponse>(fetchImpl, `${base}/v1/messages`, {
        headers,
        body: {
          model: config.model,
          system,
          messages: req.messages,
          // Current Claude models think before answering and that counts toward max_tokens, so short
          // answers (moderation, rating) get room for it. Only tokens actually used are billed.
          max_tokens: Math.max(req.maxTokens ?? 800, 1024),
        },
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
