/** Every provider call goes through `tracked` so the admin can see what Barnaby costs. */
import { and, gte, sql } from "drizzle-orm";
import type { AiProvider } from "./providers/types.js";
import type { AiContext } from "./context.js";
import { aiUsage } from "./schema.js";

type Tracked = { model: string; inputTokens?: number; outputTokens?: number };

export async function tracked<T extends Tracked>(
  ctx: Pick<AiContext, "db" | "now">,
  provider: AiProvider,
  feature: string,
  userId: string | null,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const r = await run();
    log(ctx, { userId, feature, providerId: provider.config.id, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, durationMs: Date.now() - started, ok: true });
    return r;
  } catch (e) {
    log(ctx, { userId, feature, providerId: provider.config.id, model: provider.config.model, durationMs: Date.now() - started, ok: false, error: (e as Error).message.slice(0, 300) });
    throw e;
  }
}

function log(ctx: Pick<AiContext, "db">, row: typeof aiUsage.$inferInsert) {
  try {
    ctx.db.insert(aiUsage).values(row).run();
  } catch {
    /* usage logging must never break a chat */
  }
}

export function usageSummary(ctx: AiContext, days: number) {
  const since = ctx.now().getTime() - days * 86_400_000;
  const rows = ctx.db
    .select({
      feature: aiUsage.feature,
      providerId: aiUsage.providerId,
      model: aiUsage.model,
      calls: sql<number>`count(*)`,
      failures: sql<number>`sum(case when ${aiUsage.ok} then 0 else 1 end)`,
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
      avgMs: sql<number>`cast(avg(${aiUsage.durationMs}) as integer)`,
    })
    .from(aiUsage)
    .where(and(gte(aiUsage.createdAt, since)))
    .groupBy(aiUsage.feature, aiUsage.providerId, aiUsage.model)
    .all();
  return { since, items: rows };
}
