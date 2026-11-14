/**
 * OpenAI-compatible chat completions: Ollama (/v1), LM Studio, llama.cpp server, vLLM,
 * LocalAI, OpenRouter and OpenAI itself all speak this. Embeddings use `/embeddings`
 * (Ollama: `nomic-embed-text`, `mxbai-embed-large`; OpenAI: `text-embedding-3-small`).
 */
import { postJson, postSse, trimSlash, type AiProvider, type ChatRequest, type ChatResult, type FetchLike, type ProviderConfig } from "./types.js";

interface Completion {
  model?: string;
  choices?: { message?: { content?: string | null }; delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openAiProvider(config: ProviderConfig, fetchImpl: FetchLike): AiProvider {
  const base = trimSlash(config.baseUrl || "https://api.openai.com/v1");
  const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  const timeoutMs = config.timeoutMs ?? 120_000;
  const body = (req: ChatRequest, stream: boolean) => {
    const b: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      max_tokens: req.maxTokens ?? 800,
      temperature: req.temperature ?? 0.6,
      stream,
    };
    if (req.json) b.response_format = { type: "json_object" };
    return b;
  };
  return {
    config,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const r = await postJson<Completion>(fetchImpl, `${base}/chat/completions`, {
        headers,
        body: body(req, false),
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
    async chatStream(req, onDelta) {
      let text = "";
      let model = config.model;
      let usage: Completion["usage"];
      await postSse(fetchImpl, `${base}/chat/completions`, { headers, body: body(req, true), timeoutMs, label: config.name }, (d: Completion) => {
        const piece = d.choices?.[0]?.delta?.content ?? d.choices?.[0]?.message?.content ?? "";
        if (piece) {
          text += piece;
          onDelta(piece);
        }
        if (d.model) model = d.model;
        if (d.usage) usage = d.usage;
      });
      return { text: text.trim(), model, inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
    },
    async embed(texts) {
      const r = await postJson<{ model?: string; data?: { index?: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } }>(
        fetchImpl,
        `${base}/embeddings`,
        { headers, body: { model: config.model, input: texts }, timeoutMs, label: config.name },
      );
      const data = [...(r.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return { vectors: data.map((d) => d.embedding), model: r.model ?? config.model, inputTokens: r.usage?.prompt_tokens };
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
