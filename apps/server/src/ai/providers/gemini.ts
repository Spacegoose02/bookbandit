/** Google Gemini (generativelanguage.googleapis.com). Embeddings: `text-embedding-004`, `gemini-embedding-001`. */
import { postJson, postSse, trimSlash, type AiProvider, type ChatRequest, type ChatResult, type FetchLike, type ProviderConfig } from "./types.js";

interface GenerateResponse {
  modelVersion?: string;
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const textOf = (r: GenerateResponse) => (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");

export function geminiProvider(config: ProviderConfig, fetchImpl: FetchLike): AiProvider {
  const base = trimSlash(config.baseUrl || "https://generativelanguage.googleapis.com/v1beta");
  const headers: Record<string, string> = config.apiKey ? { "x-goog-api-key": config.apiKey } : {};
  const timeoutMs = config.timeoutMs ?? 120_000;
  const model = config.model.replace(/^models\//, "");
  const body = (req: ChatRequest) => {
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: req.maxTokens ?? 800,
      temperature: req.temperature ?? 0.6,
    };
    if (req.json) generationConfig.responseMimeType = "application/json";
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig,
    };
  };
  return {
    config,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const r = await postJson<GenerateResponse>(fetchImpl, `${base}/models/${encodeURIComponent(model)}:generateContent`, {
        headers,
        body: body(req),
        timeoutMs,
        label: config.name,
      });
      return {
        text: textOf(r).trim(),
        model: r.modelVersion ?? model,
        inputTokens: r.usageMetadata?.promptTokenCount,
        outputTokens: r.usageMetadata?.candidatesTokenCount,
      };
    },
    async chatStream(req, onDelta) {
      let text = "";
      let last: GenerateResponse = {};
      await postSse(
        fetchImpl,
        `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        { headers, body: body(req), timeoutMs, label: config.name },
        (d: GenerateResponse) => {
          const piece = textOf(d);
          if (piece) {
            text += piece;
            onDelta(piece);
          }
          last = { ...last, ...d };
        },
      );
      return {
        text: text.trim(),
        model: last.modelVersion ?? model,
        inputTokens: last.usageMetadata?.promptTokenCount,
        outputTokens: last.usageMetadata?.candidatesTokenCount,
      };
    },
    async embed(texts) {
      const r = await postJson<{ embeddings?: { values: number[] }[] }>(fetchImpl, `${base}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
        headers,
        body: { requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) },
        timeoutMs,
        label: config.name,
      });
      return { vectors: (r.embeddings ?? []).map((e) => e.values), model };
    },
    async listModels() {
      const r = await postJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>(
        fetchImpl,
        `${base}/models?pageSize=200`,
        { headers, timeoutMs: 15_000, label: config.name },
      );
      return (r.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.some((x) => x === "generateContent" || x === "embedContent"))
        .map((m) => m.name.replace(/^models\//, ""));
    },
  };
}
