/**
 * Rough AI prices so the admin can see what a batch will cost before running it.
 * Prices are US dollars per million tokens. They drift, so an admin can type their own
 * per provider (`price` in the provider settings), which always wins over this table.
 */

export interface TokenPrice {
  /** $ per million input tokens. */
  input: number;
  /** $ per million output tokens. */
  output: number;
}

export type PriceSource = "local" | "custom" | "table" | "unknown";

/**
 * Known cloud models, matched by prefix on the model name (longest prefix wins).
 * Claude prices are first-party API rates as of November 2026; others are best effort.
 */
export const KNOWN_PRICES: Record<string, TokenPrice> = {
  // Anthropic
  "claude-fable-5-2": { input: 8, output: 40 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4": { input: 1, output: 5 },
  // OpenAI
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  // Google
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
};

/**
 * A server in the house (Ollama, LM Studio, llama.cpp) costs nothing per token. A base URL is
 * local when its host is localhost, a private address, a bare Docker service name ("ollama") or
 * ends in .local/.lan/.home/.internal.
 */
export function isLocalUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return true;
  if (!host.includes(".") && !host.includes(":")) return true; // docker service name
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(host)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd][0-9a-f]{2}:/.test(host); // IPv6 unique-local
}

export interface PricedProvider {
  kind: string;
  baseUrl?: string;
  model: string;
  price?: TokenPrice | null;
}

/** What a provider costs per token, and where that number came from. */
export function priceFor(p: PricedProvider): { price: TokenPrice | null; source: PriceSource } {
  if (p.price) return { price: p.price, source: "custom" };
  if (p.kind === "openai" && isLocalUrl(p.baseUrl)) return { price: { input: 0, output: 0 }, source: "local" };
  const model = p.model.toLowerCase().replace(/^(models\/|anthropic\.|openai\/|google\/)/, "");
  let best: string | null = null;
  for (const k of Object.keys(KNOWN_PRICES)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? { price: KNOWN_PRICES[best]!, source: "table" } : { price: null, source: "unknown" };
}

/** Dollars for a number of tokens at a price. */
export function tokenCost(price: TokenPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** "$0.42", "under $0.01", "free", "unknown". */
export function formatCost(dollars: number | null, free = false): string {
  if (free) return "free";
  if (dollars == null) return "unknown";
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return "under $0.01";
  return `$${dollars < 100 ? dollars.toFixed(2) : Math.round(dollars).toLocaleString("en-US")}`;
}
