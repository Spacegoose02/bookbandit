import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { openAiProvider } from "./openai.js";
import type { AiProvider, FetchLike, ProviderConfig } from "./types.js";

export * from "./types.js";

export function makeProvider(config: ProviderConfig, fetchImpl: FetchLike): AiProvider {
  switch (config.kind) {
    case "openai":
      return openAiProvider(config, fetchImpl);
    case "anthropic":
      return anthropicProvider(config, fetchImpl);
    case "gemini":
      return geminiProvider(config, fetchImpl);
  }
}
