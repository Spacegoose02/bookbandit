/**
 * Job runner plugin. Decorates the root instance with `app.jobs` so every module can
 * `app.jobs.register(type, handler)` and `app.jobs.enqueue(type, payload)`.
 * Register it before any plugin that registers handlers (see app.ts).
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import { JobRunner } from "./runner.js";
import { jobRoutes } from "./routes.js";

export { JobRunner, PermanentJobError, type JobContext, type JobHandler } from "./runner.js";

declare module "fastify" {
  interface FastifyInstance {
    jobs: JobRunner;
  }
}

export interface JobsOptions {
  db: Db;
  concurrency?: number;
  /** false: don't poll (tests drive the runner with `app.jobs.drain()`). Default: start on listen. */
  autostart?: boolean;
}

export const jobsPlugin = fp(async (app: FastifyInstance, opts: JobsOptions) => {
  const runner = new JobRunner({ db: opts.db, log: app.log, concurrency: opts.concurrency });
  app.decorate("jobs", runner);
  // onListen only fires for a real server, so app.inject() tests never start the poller.
  if (opts.autostart !== false) app.addHook("onListen", async () => runner.start());
  app.addHook("onClose", async () => runner.stop());
  await app.register(jobRoutes, { db: opts.db, runner });
});
