/**
 * OpenAI-compatible chat completions: Ollama (/v1), LM Studio, llama.cpp server, vLLM,
 * LocalAI, OpenRouter and OpenAI itself all speak this.
 */
import { postJson, trimSlash, type AiProvider, type ChatRequest, type ChatResult, type FetchLike, type ProviderConfig } from "./types.js";

interface Completion {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openAiProvider(config: ProviderConfig, fetchImpl: FetchLike): AiProvider {
  const base = trimSlash(config.baseUrl || "https://api.openai.com/v1");
  const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  const timeoutMs = config.timeoutMs ?? 120_000;
  return {
    config,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        max_tokens: req.maxTokens ?? 800,
        temperature: req.temperature ?? 0.6,
        stream: false,
      };
      if (req.json) body.response_format = { type: "json_object" };
      const r = await postJson<Completion>(fetchImpl, `${base}/chat/completions`, {
        headers,
        body,
        timeoutMs,
        label: config.name,
      });
      return {
        text: r.choices?.[0]?.message?.content?.trim() ?? "",
        model: r.model ?? config.model,
        inputTokens: r.usage?.prompt_tokens,
        outputTokens: r.usage?.completion_tokens,
      };
    },
    async listModels() {
      const r = await postJson<{ data?: { id: string }[] }>(fetchImpl, `${base}/models`, {
        headers,
        timeoutMs: 15_000,
        label: config.name,
      });
      return (r.data ?? []).map((m) => m.id).sort();
    },
  };
}
