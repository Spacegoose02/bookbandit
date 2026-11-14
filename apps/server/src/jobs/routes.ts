/** Admin job status API (requireAdmin). */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { httpError, requireAdmin } from "../auth/plugin.js";
import { parse } from "../requests/validate.js";
import type { JobRow, JobRunner } from "./runner.js";

const STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
const ListQuery = z.object({
  status: z.enum(STATUSES).optional(),
  type: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });

export function jobView(j: JobRow) {
  return {
    id: j.id,
    type: j.type,
    label: j.label,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    progress: j.progress,
    lastError: j.lastError,
    result: j.result ?? null,
    runAfter: j.runAfter,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    updatedAt: j.updatedAt,
  };
}

export async function jobRoutes(app: FastifyInstance, opts: { db: Db; runner: JobRunner }) {
  const { db, runner } = opts;

  app.get("/api/admin/jobs", async (req) => {
    requireAdmin(req);
    const q = parse(ListQuery, req.query);
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(jobs.status, q.status));
    if (q.type) conds.push(eq(jobs.type, q.type));
    const where = conds.length ? and(...conds) : undefined;
    const rows = db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(q.limit).offset(q.offset).all();
    const total = db.select({ n: sql<number>`count(*)` }).from(jobs).where(where).get()?.n ?? 0;
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
    for (const r of db.select({ status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status).all()) {
      counts[r.status] = r.n;
    }
    return { items: rows.map(jobView), total, counts, types: runner.types() };
  });

  app.get("/api/admin/jobs/:id", async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const job = runner.get(id);
    if (!job) throw httpError(404, "Not found");
    return { ...jobView(job), payload: job.payload, logs: runner.logs(id) };
  });

  app.post("/api/admin/jobs/:id/retry", async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const job = runner.get(id);
    if (!job) throw httpError(404, "Not found");
    if (job.status !== "failed" && job.status !== "cancelled") throw httpError(409, `Job is ${job.status}`);
    return jobView(runner.retry(id)!);
  });

  app.post("/api/admin/jobs/:id/cancel", async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const job = runner.get(id);
    if (!job) throw httpError(404, "Not found");
    if (job.status !== "queued" && job.status !== "running") throw httpError(409, `Job is ${job.status}`);
    return jobView((await runner.cancel(id))!);
  });
}
