/** Google Gemini (generativelanguage.googleapis.com). */
import { postJson, trimSlash, type AiProvider, type ChatRequest, type ChatResult, type FetchLike, type ProviderConfig } from "./types.js";

interface GenerateResponse {
  modelVersion?: string;
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function geminiProvider(config: ProviderConfig, fetchImpl: FetchLike): AiProvider {
  const base = trimSlash(config.baseUrl || "https://generativelanguage.googleapis.com/v1beta");
  const headers: Record<string, string> = config.apiKey ? { "x-goog-api-key": config.apiKey } : {};
  const timeoutMs = config.timeoutMs ?? 120_000;
  const model = config.model.replace(/^models\//, "");
  return {
    config,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: req.maxTokens ?? 800,
        temperature: req.temperature ?? 0.6,
      };
      if (req.json) generationConfig.responseMimeType = "application/json";
      const r = await postJson<GenerateResponse>(fetchImpl, `${base}/models/${encodeURIComponent(model)}:generateContent`, {
        headers,
        body: {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig,
        },
        timeoutMs,
        label: config.name,
      });
      return {
        text: (r.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("")
          .trim(),
        model: r.modelVersion ?? model,
        inputTokens: r.usageMetadata?.promptTokenCount,
        outputTokens: r.usageMetadata?.candidatesTokenCount,
      };
    },
    async listModels() {
      const r = await postJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>(
        fetchImpl,
        `${base}/models?pageSize=200`,
        { headers, timeoutMs: 15_000, label: config.name },
      );
      return (r.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""));
    },
  };
}
