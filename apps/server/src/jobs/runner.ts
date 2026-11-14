/**
 * Generic background job runner on the `jobs` table.
 *
 * - `enqueue(type, payload)` stores a job; a handler registered for that type runs it.
 * - Failures retry with exponential backoff until `maxAttempts`, then the job is `failed`.
 *   Throw `PermanentJobError` to fail at once (bad input, nothing to retry).
 * - `ctx.defer(ms)` puts a job back in the queue without counting an attempt: use it to poll
 *   an outside service (a download that takes an hour) without holding a worker.
 * - `ctx.update(payload)` saves state between deferrals, so a multi-step job resumes where it was.
 * - Jobs left `running` by a crash or restart go back to `queued` when the runner starts.
 * - Jobs whose type has no handler stay queued (another module may register it later).
 *
 * One process, SQLite: claiming is an UPDATE … WHERE status='queued', so a job never runs twice.
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { jobLogs } from "./schema.js";

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = JobRow["status"];
export type LogLevel = "info" | "warn" | "error";

export interface JobContext<P = unknown> {
  jobId: string;
  /** 1 on the first run; deferrals don't count. */
  attempt: number;
  maxAttempts: number;
  /** Aborted when an admin cancels the job or the server shuts down. */
  signal: AbortSignal;
  log(message: string, level?: LogLevel): void;
  /** 0..1 */
  progress(fraction: number): void;
  /** Save new payload state (e.g. the outside service's id) for the next run. */
  update(payload: P): void;
  /** Stop this run and come back in `ms`, without counting it as an attempt. */
  defer(ms: number, message?: string): never;
  /** Run another registered handler inline, as a step of this job (shares this job's log). */
  invoke(type: string, payload?: unknown): Promise<unknown>;
}

export type JobHandler<P = any> = (payload: P, ctx: JobContext<P>) => Promise<unknown>;

export interface HandlerOptions<P = any> {
  /** Default for jobs of this type; enqueue() can override. */
  maxAttempts?: number;
  /** Delay before retry N (1-based). Default 30 s, doubling, at most 1 h. */
  backoffMs?: (attempt: number) => number;
  /** Called once when a job of this type ends failed (out of attempts, or permanent). */
  onFailed?: (payload: P, error: string, jobId: string) => void | Promise<void>;
  /** Called when an admin cancels a job of this type. */
  onCancelled?: (payload: P, jobId: string) => void | Promise<void>;
}

export interface EnqueueOptions {
  label?: string;
  maxAttempts?: number;
  /** Epoch ms; default now. */
  runAfter?: number;
}

/** Fail now, no retries. */
export class PermanentJobError extends Error {}

class DeferSignal {
  constructor(
    readonly ms: number,
    readonly message?: string,
  ) {}
}

export function defaultBackoff(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

export interface RunnerOptions {
  db: Db;
  log?: FastifyBaseLogger;
  /** Jobs running at once. Default 2. */
  concurrency?: number;
  /** How often to look for due jobs when idle. Default 2 s. */
  pollMs?: number;
  now?: () => number;
}

interface Registered {
  handler: JobHandler;
  opts: HandlerOptions;
}

export class JobRunner {
  private readonly handlers = new Map<string, Registered>();
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly db: Db;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: RunnerOptions) {
    this.db = opts.db;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.pollMs = opts.pollMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  register<P>(type: string, handler: JobHandler<P>, opts: HandlerOptions<P> = {}): void {
    if (this.handlers.has(type)) throw new Error(`job type ${type} is already registered`);
    this.handlers.set(type, { handler: handler as JobHandler, opts: opts as HandlerOptions });
    this.wake();
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()].sort();
  }

  enqueue(type: string, payload: unknown = {}, opts: EnqueueOptions = {}): string {
    const now = this.now();
    const id = crypto.randomUUID();
    this.db
      .insert(jobs)
      .values({
        id,
        type,
        payload: payload ?? {},
        status: "queued",
        label: opts.label ?? null,
        maxAttempts: opts.maxAttempts ?? this.handlers.get(type)?.opts.maxAttempts ?? 5,
        runAfter: opts.runAfter ?? now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.wake();
    return id;
  }

  get(id: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  log(jobId: string, message: string, level: LogLevel = "info"): void {
    this.db.insert(jobLogs).values({ jobId, at: this.now(), level, message: message.slice(0, 4000) }).run();
  }

  logs(jobId: string, limit = 500) {
    return this.db
      .select({ at: jobLogs.at, level: jobLogs.level, message: jobLogs.message })
      .from(jobLogs)
      .where(eq(jobLogs.jobId, jobId))
      .orderBy(asc(jobLogs.id))
      .limit(limit)
      .all();
  }

  /** Put a failed or cancelled job back in the queue with fresh attempts. */
  retry(id: string): JobRow | undefined {
    const now = this.now();
    const changed = this.db
      .update(jobs)
      .set({ status: "queued", attempts: 0, runAfter: now, lastError: null, finishedAt: null, updatedAt: now })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ["failed", "cancelled"])))
      .run().changes;
    if (changed) {
      this.log(id, "Retry requested");
      this.wake();
    }
    return this.get(id);
  }

  /** Cancel a queued job now, or ask a running one to stop. */
  async cancel(id: string): Promise<JobRow | undefined> {
    const job = this.get(id);
    if (!job) return undefined;
    if (job.status === "queued") {
      this.finish(id, "cancelled", { lastError: "Cancelled" });
      this.log(id, "Cancelled", "warn");
      await this.handlers.get(job.type)?.opts.onCancelled?.(job.payload, id);
    } else if (job.status === "running") {
      const r = this.running.get(id);
      r?.controller.abort();
      await r?.done;
    }
    return this.get(id);
  }

  /** Start polling. Jobs left running by a previous process are re-queued first. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const requeued = this.db
      .update(jobs)
      .set({ status: "queued", updatedAt: this.now() })
      .where(eq(jobs.status, "running"))
      .run().changes;
    if (requeued) this.opts.log?.info({ requeued }, "re-queued jobs interrupted by a restart");
    this.schedule(0);
  }

  /** Stop polling and abort running jobs (they go back to queued for the next start). */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const r of this.running.values()) r.controller.abort("shutdown");
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  /**
   * Claim due jobs up to the free worker slots and wait for them to finish.
   * Returns how many ran. Tests call this (or drain) instead of start().
   */
  async tick(): Promise<number> {
    const free = this.concurrency - this.running.size;
    if (free <= 0 || !this.handlers.size) return 0;
    const due = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, this.now()), inArray(jobs.type, this.types())))
      .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(free)
      .all();
    const started: Promise<void>[] = [];
    for (const job of due) {
      const p = this.claimAndRun(job);
      if (p) started.push(p);
    }
    await Promise.all(started);
    return started.length;
  }

  /** Run every due job, including ones enqueued by other jobs, until none are left. */
  async drain(maxRounds = 100): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if (!(await this.tick()) && !this.running.size) return;
    }
  }

  private claimAndRun(job: JobRow): Promise<void> | null {
    const now = this.now();
    const claimed = this.db
      .update(jobs)
      .set({ status: "running", attempts: sql`${jobs.attempts} + 1`, startedAt: now, updatedAt: now })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued")))
      .run().changes;
    if (!claimed) return null;
    const controller = new AbortController();
    const done = this.execute({ ...job, attempts: job.attempts + 1 }, controller).finally(() => {
      this.running.delete(job.id);
      this.wake();
    });
    this.running.set(job.id, { controller, done });
    return done;
  }

  private async execute(job: JobRow, controller: AbortController): Promise<void> {
    const reg = this.handlers.get(job.type)!;
    let payload = job.payload;
    const ctx: JobContext = {
      jobId: job.id,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      signal: controller.signal,
      log: (message, level) => this.log(job.id, message, level),
      progress: (fraction) => {
        const p = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
        this.db.update(jobs).set({ progress: p, updatedAt: this.now() }).where(eq(jobs.id, job.id)).run();
      },
      update: (next) => {
        payload = next;
        this.db.update(jobs).set({ payload: next ?? {}, updatedAt: this.now() }).where(eq(jobs.id, job.id)).run();
      },
      defer: (ms, message) => {
        throw new DeferSignal(ms, message);
      },
      invoke: async (type, p = {}) => {
        const sub = this.handlers.get(type);
        if (!sub) throw new Error(`No handler for job type ${type}`);
        return sub.handler(p, ctx);
      },
    };

    try {
      const result = await reg.handler(payload, ctx);
      this.finish(job.id, "done", { result: result ?? null, progress: 1 });
    } catch (err) {
      if (err instanceof DeferSignal) {
        if (err.message) this.log(job.id, err.message);
        const now = this.now();
        this.db
          .update(jobs)
          .set({ status: "queued", attempts: sql`${jobs.attempts} - 1`, runAfter: now + Math.max(0, err.ms), updatedAt: now })
          .where(eq(jobs.id, job.id))
          .run();
        return;
      }
      if (controller.signal.aborted) {
        if (controller.signal.reason === "shutdown") {
          // Not the job's fault: run it again on the next start.
          this.db
            .update(jobs)
            .set({ status: "queued", attempts: sql`${jobs.attempts} - 1`, updatedAt: this.now() })
            .where(eq(jobs.id, job.id))
            .run();
          return;
        }
        this.finish(job.id, "cancelled", { lastError: "Cancelled" });
        this.log(job.id, "Cancelled", "warn");
        await this.safely(() => reg.opts.onCancelled?.(payload, job.id));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(job.id, message, "error");
      const permanent = err instanceof PermanentJobError;
      if (permanent || job.attempts >= job.maxAttempts) {
        this.finish(job.id, "failed", { lastError: message });
        await this.safely(() => reg.opts.onFailed?.(payload, message, job.id));
        return;
      }
      const delay = (reg.opts.backoffMs ?? defaultBackoff)(job.attempts);
      this.log(job.id, `Attempt ${job.attempts} of ${job.maxAttempts} failed; retrying in ${Math.round(delay / 1000)} s`, "warn");
      const now = this.now();
      this.db
        .update(jobs)
        .set({ status: "queued", lastError: message, runAfter: now + delay, updatedAt: now })
        .where(eq(jobs.id, job.id))
        .run();
    }
  }

  private finish(id: string, status: "done" | "failed" | "cancelled", extra: Partial<typeof jobs.$inferInsert> = {}): void {
    const now = this.now();
    this.db
      .update(jobs)
      .set({ status, finishedAt: now, updatedAt: now, ...extra })
      .where(eq(jobs.id, id))
      .run();
  }

  private async safely(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.opts.log?.error({ err }, "job hook failed");
    }
  }

  private wake(): void {
    if (this.started) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, ms);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    if (!this.started) return;
    try {
      // Don't await: running jobs finish on their own and call wake().
      const free = this.concurrency - this.running.size;
      if (free > 0) void this.tick();
    } catch (err) {
      this.opts.log?.error({ err }, "job runner tick failed");
    }
    this.schedule(this.pollMs);
  }
}
