/** Anthropic Messages API (Claude). */
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
          max_tokens: req.maxTokens ?? 800,
          temperature: req.temperature ?? 0.6,
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
