/**
 * Barnaby's background work on the shared job runner (apps/server/src/jobs):
 *
 * - `ai.rating`: the rating helper over a list of books.
 * - `ai.metadata`: metadata cleanup suggestions over a list of books.
 * - `ai.embed`: (re)build meaning-search embeddings for changed books.
 *
 * The book-list jobs keep their place in the payload after every book, so a restart picks up
 * where it stopped, and the admin jobs page shows their progress and log.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { jobs } from "../db/schema.js";
import { httpError } from "../auth/plugin.js";
import { PermanentJobError, type JobContext, type JobRunner } from "../jobs/index.js";
import type { AiContext } from "./context.js";
import { indexBooks, type IndexResult } from "./embeddings.js";
import { checkMetadata } from "./metadata.js";
import { rateBook } from "./rating.js";

export const AI_JOB_TYPES = { rating: "ai.rating", metadata: "ai.metadata", embed: "ai.embed" } as const;

export interface BatchPayload {
  ids: string[];
  done: number;
  /** Books the step produced something for (a rating suggestion, metadata suggestions). */
  suggested: number;
  /** Rating helper: stricter ratings applied at once. Metadata: field suggestions stored. */
  applied: number;
  failed: number;
  /** Books the step threw on. Later batches skip them until an admin asks to try them again. */
  failedIds?: string[];
  lastError: string | null;
  userId: string | null;
  applyStricter?: boolean;
}

export interface BatchStatus {
  jobId: string | null;
  running: boolean;
  total: number;
  done: number;
  suggested: number;
  applied: number;
  failed: number;
  lastError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const IDLE: BatchStatus = { jobId: null, running: false, total: 0, done: 0, suggested: 0, applied: 0, failed: 0, lastError: null, startedAt: null, finishedAt: null };

export function latestJob(ctx: AiContext, type: string) {
  return ctx.db.select().from(jobs).where(eq(jobs.type, type)).orderBy(desc(jobs.createdAt)).limit(1).get();
}

export function isBusy(ctx: AiContext, type: string): boolean {
  return !!ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, type), inArray(jobs.status, ["queued", "running"])))
    .get();
}

export function batchStatus(ctx: AiContext, type: string): BatchStatus {
  const job = latestJob(ctx, type);
  if (!job) return { ...IDLE };
  const p = job.payload as BatchPayload;
  return {
    jobId: job.id,
    running: job.status === "queued" || job.status === "running",
    total: p.ids?.length ?? 0,
    done: p.done ?? 0,
    suggested: p.suggested ?? 0,
    applied: p.applied ?? 0,
    failed: p.failed ?? 0,
    lastError: p.lastError ?? (job.status === "failed" || job.status === "cancelled" ? job.lastError : null),
    startedAt: job.startedAt ?? job.createdAt,
    finishedAt: job.finishedAt ?? null,
  };
}

/**
 * Books that failed in any earlier run of this type (a reply the model garbled, a timeout).
 * Without this, a book that always fails would sit at the front of every new batch.
 */
export function failedBookIds(ctx: AiContext, type: string): string[] {
  const rows = ctx.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.type, type)).all();
  const ids = new Set<string>();
  for (const r of rows) for (const id of (r.payload as BatchPayload | null)?.failedIds ?? []) ids.add(id);
  return [...ids];
}

export function startBatch(ctx: AiContext, runner: JobRunner, type: string, ids: string[], label: string, extra: Partial<BatchPayload> = {}): BatchStatus {
  if (isBusy(ctx, type)) throw httpError(409, "That's already running");
  const payload: BatchPayload = { ids, done: 0, suggested: 0, applied: 0, failed: 0, lastError: null, userId: null, ...extra };
  runner.enqueue(type, payload, { label, maxAttempts: 3 });
  return batchStatus(ctx, type);
}

/** Runs `step` for each id from where the payload left off. One book failing doesn't fail the job. */
function batchHandler(step: (id: string, p: BatchPayload) => Promise<{ suggested: boolean; applied: number } | null>) {
  return async (payload: BatchPayload, job: JobContext<BatchPayload>) => {
    const p: BatchPayload = { ...payload };
    for (let i = p.done; i < p.ids.length; i++) {
      if (job.signal.aborted) throw new Error("Cancelled");
      try {
        const r = await step(p.ids[i]!, p);
        if (r?.suggested) p.suggested++;
        p.applied += r?.applied ?? 0;
      } catch (e) {
        const msg = (e as Error).message;
        // No provider any more: nothing else will work either.
        if ((e as { statusCode?: number }).statusCode === 503) throw new PermanentJobError(msg);
        p.failed++;
        p.failedIds = [...(p.failedIds ?? []), p.ids[i]!];
        p.lastError = msg;
        job.log(msg, "warn");
      }
      p.done = i + 1;
      job.update(p);
      job.progress(p.ids.length ? p.done / p.ids.length : 1);
    }
    return { total: p.ids.length, suggested: p.suggested, applied: p.applied, failed: p.failed };
  };
}

export function registerAiJobs(ctx: AiContext, runner: JobRunner): void {
  runner.register<BatchPayload>(
    AI_JOB_TYPES.rating,
    batchHandler(async (id, p) => {
      const r = await rateBook(ctx, id, p.applyStricter ?? true, p.userId);
      return r ? { suggested: true, applied: r.applied ? 1 : 0 } : null;
    }),
  );
  runner.register<BatchPayload>(
    AI_JOB_TYPES.metadata,
    batchHandler(async (id, p) => {
      const n = await checkMetadata(ctx, id, p.userId);
      return { suggested: n > 0, applied: n };
    }),
  );
  runner.register<{ bookIds?: string[]; userId?: string | null; result?: IndexResult }>(AI_JOB_TYPES.embed, async (payload, job) => {
    try {
      return await indexBooks(ctx, { bookIds: payload.bookIds, userId: payload.userId, signal: job.signal, progress: job.progress, log: (m) => job.log(m) });
    } catch (e) {
      if (/Pick an embeddings provider/.test((e as Error).message)) throw new PermanentJobError((e as Error).message);
      throw e;
    }
  });
}

/** Queue an index run unless one is already waiting. */
export function queueEmbedding(ctx: AiContext, runner: JobRunner, userId: string | null, bookIds?: string[]): string | null {
  if (!bookIds && isBusy(ctx, AI_JOB_TYPES.embed)) return null;
  return runner.enqueue(AI_JOB_TYPES.embed, { bookIds, userId }, { label: bookIds ? `Meaning search: ${bookIds.length} books` : "Meaning search: index the library", maxAttempts: 3 });
}
