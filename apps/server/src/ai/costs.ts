/**
 * Cost estimates for Barnaby's batch tools: what the next run and the rest of the library
 * would cost, and what the tool has spent so far. Token counts come from the usage log
 * (`ai_usage`); prices from the provider's own `price` or the shared table. Local servers are free.
 */
import { and, desc, eq } from "drizzle-orm";
import { priceFor, tokenCost, type PriceSource } from "@bookbandit/shared";
import type { AiContext } from "./context.js";
import { aiUsage } from "./schema.js";
import { getAiSettings, providerFor, type AiFeature } from "./settings.js";

/** A first guess per book before we've seen real calls: the prompt with an opening/description, and a short JSON reply. */
const FIRST_GUESS: Partial<Record<AiFeature, { input: number; output: number }>> = {
  rating: { input: 1800, output: 80 },
  metadata: { input: 1200, output: 250 },
};

export interface CostEstimate {
  /** Provider name and model the next run would use; null when none is picked. */
  provider: string | null;
  model: string | null;
  source: PriceSource;
  /** True for a server in the house: no per-token cost. */
  free: boolean;
  /** Dollars per book; null when the model's price isn't known. */
  perBook: number | null;
  /** "history" once a few real calls are logged, otherwise "guess". */
  basis: "history" | "guess";
}

export interface Spend {
  /** Dollars spent so far, counting only calls whose price we know. */
  dollars: number;
  calls: number;
  /** Some calls used a model whose price isn't known, so `dollars` is a floor. */
  partial: boolean;
}

/** Average tokens per call for this feature and model, from the last 200 good calls. */
function averageTokens(ctx: AiContext, feature: AiFeature, model: string) {
  const rows = ctx.db
    .select({ input: aiUsage.inputTokens, output: aiUsage.outputTokens })
    .from(aiUsage)
    .where(and(eq(aiUsage.feature, feature), eq(aiUsage.model, model), eq(aiUsage.ok, true)))
    .orderBy(desc(aiUsage.createdAt))
    .limit(200)
    .all()
    .filter((r) => r.input != null);
  if (rows.length < 3) return null;
  let input = 0;
  let output = 0;
  for (const r of rows) {
    input += r.input ?? 0;
    output += r.output ?? 0;
  }
  const sum = { input, output };
  return { input: sum.input / rows.length, output: sum.output / rows.length };
}

export function estimateCost(ctx: AiContext, feature: AiFeature): CostEstimate {
  const config = providerFor(getAiSettings(ctx.db, ctx.box), feature);
  if (!config) return { provider: null, model: null, source: "unknown", free: false, perBook: null, basis: "guess" };
  const { price, source } = priceFor(config);
  const seen = averageTokens(ctx, feature, config.model);
  const tokens = seen ?? FIRST_GUESS[feature] ?? { input: 1000, output: 200 };
  return {
    provider: config.name,
    model: config.model,
    source,
    free: source === "local" || (!!price && price.input === 0 && price.output === 0),
    perBook: price ? tokenCost(price, tokens.input, tokens.output) : null,
    basis: seen ? "history" : "guess",
  };
}

/** What this feature has cost so far, all time. Calls to a provider that's since been removed are priced from the table. */
export function spentOn(ctx: AiContext, feature: AiFeature): Spend {
  const providers = getAiSettings(ctx.db, ctx.box).providers;
  const rows = ctx.db
    .select({ providerId: aiUsage.providerId, model: aiUsage.model, input: aiUsage.inputTokens, output: aiUsage.outputTokens })
    .from(aiUsage)
    .where(eq(aiUsage.feature, feature))
    .all();
  let dollars = 0;
  let partial = false;
  const prices = new Map<string, ReturnType<typeof priceFor>>();
  for (const r of rows) {
    const key = `${r.providerId}\u0000${r.model}`;
    let p = prices.get(key);
    if (!p) {
      const config = providers.find((c) => c.id === r.providerId);
      p = priceFor(config ? { ...config, model: r.model } : { kind: "unknown", model: r.model });
      prices.set(key, p);
    }
    if (!p.price) partial = true;
    else dollars += tokenCost(p.price, r.input ?? 0, r.output ?? 0);
  }
  return { dollars, calls: rows.length, partial };
}
