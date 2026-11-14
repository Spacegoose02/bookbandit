import { describe, expect, it } from "vitest";
import { formatCost, isLocalUrl, priceFor, tokenCost } from "./ai-pricing.js";

describe("ai pricing", () => {
  it("treats servers in the house as free", () => {
    for (const u of ["http://ollama:11434/v1", "http://localhost:1234/v1", "http://192.168.1.20:8080", "http://nas.local:11434", "http://10.0.0.5/v1"])
      expect(isLocalUrl(u)).toBe(true);
    for (const u of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://8.8.8.8", undefined]) expect(isLocalUrl(u)).toBe(false);
    expect(priceFor({ kind: "openai", baseUrl: "http://ollama:11434/v1", model: "llama3.2" })).toMatchObject({ source: "local", price: { input: 0 } });
  });

  it("looks up cloud models by the longest matching prefix", () => {
    expect(priceFor({ kind: "anthropic", model: "claude-haiku-5-5" }).price).toEqual({ input: 0.1, output: 0.5 });
    expect(priceFor({ kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" }).price).toEqual({ input: 0.25, output: 2 });
    expect(priceFor({ kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5" }).price).toEqual({ input: 1.25, output: 10 });
    expect(priceFor({ kind: "openai", baseUrl: "https://example.com/v1", model: "mystery-1" })).toEqual({ price: null, source: "unknown" });
  });

  it("an admin's own price wins", () => {
    expect(priceFor({ kind: "anthropic", model: "claude-haiku-5-5", price: { input: 1, output: 2 } })).toEqual({
      price: { input: 1, output: 2 },
      source: "custom",
    });
  });

  it("works out and formats dollars", () => {
    expect(tokenCost({ input: 1, output: 5 }, 1_000_000, 100_000)).toBeCloseTo(1.5);
    expect(formatCost(0.004)).toBe("under $0.01");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(0, true)).toBe("free");
    expect(formatCost(null)).toBe("unknown");
  });
});
