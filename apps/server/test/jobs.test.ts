import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../src/db/client.js";
import { jobs } from "../src/db/schema.js";
import { JobRunner, PermanentJobError, defaultBackoff } from "../src/jobs/runner.js";
import { family, type Family } from "./helpers.js";

let db: Db;
let close: () => void;
let clock: number;
let runner: JobRunner;

beforeEach(() => {
  ({ db, close } = openDb(":memory:"));
  clock = 1_000_000;
  runner = new JobRunner({ db, now: () => clock });
});
afterEach(async () => {
  await runner.stop();
  close();
});

const row = (id: string) => db.select().from(jobs).where(eq(jobs.id, id)).get()!;

describe("job runner", () => {
  it("runs a job and stores its result, progress and logs", async () => {
    runner.register<{ n: number }>("double", async (p, ctx) => {
      ctx.log(`doubling ${p.n}`);
      ctx.progress(0.5);
      return { value: p.n * 2 };
    });
    const id = runner.enqueue("double", { n: 21 }, { label: "Double 21" });
    await runner.drain();
    expect(row(id)).toMatchObject({ status: "done", attempts: 1, result: { value: 42 }, progress: 1, label: "Double 21" });
    expect(runner.logs(id).map((l) => l.message)).toEqual(["doubling 21"]);
  });

  it("retries with exponential backoff, then fails and calls onFailed", async () => {
    const failed: string[] = [];
    runner.register("flaky", async () => {
      throw new Error("service down");
    }, { maxAttempts: 3, onFailed: (_p, err) => void failed.push(err) });
    const id = runner.enqueue("flaky");

    await runner.drain();
    expect(row(id)).toMatchObject({ status: "queued", attempts: 1, lastError: "service down", runAfter: clock + defaultBackoff(1) });
    // Not due yet: nothing runs.
    await runner.drain();
    expect(row(id).attempts).toBe(1);

    clock += defaultBackoff(1);
    await runner.drain();
    expect(row(id)).toMatchObject({ status: "queued", attempts: 2, runAfter: clock + defaultBackoff(2) });
    expect(defaultBackoff(2)).toBe(2 * defaultBackoff(1));

    clock += defaultBackoff(2);
    await runner.drain();
    expect(row(id)).toMatchObject({ status: "failed", attempts: 3 });
    expect(failed).toEqual(["service down"]);
  });

  it("fails at once on a PermanentJobError", async () => {
    runner.register("bad", async () => {
      throw new PermanentJobError("no such book");
    });
    const id = runner.enqueue("bad");
    await runner.drain();
    expect(row(id)).toMatchObject({ status: "failed", attempts: 1, lastError: "no such book" });
  });

  it("defers without using an attempt and keeps payload updates", async () => {
    let calls = 0;
    runner.register<{ stage: string }>("poll", async (p, ctx) => {
      calls++;
      if (p.stage === "wait") return { stage: p.stage, calls };
      ctx.update({ stage: "wait" });
      ctx.defer(15_000, "waiting on the service");
    });
    const id = runner.enqueue("poll", { stage: "start" });
    await runner.drain();
    expect(row(id)).toMatchObject({ status: "queued", attempts: 0, payload: { stage: "wait" }, runAfter: clock + 15_000 });
    clock += 15_000;
    await runner.drain();
    expect(row(id)).toMatchObject({ status: "done", attempts: 1, result: { stage: "wait", calls: 2 } });
  });

  it("leaves jobs with no handler queued, and runs them once one registers", async () => {
    const id = runner.enqueue("later", { x: 1 });
    await runner.drain();
    expect(row(id).status).toBe("queued");
    runner.register("later", async () => "ok");
    await runner.drain();
    expect(row(id).status).toBe("done");
  });

  it("cancels queued and running jobs, and retries cancelled ones", async () => {
    const cancelled: string[] = [];
    let release!: () => void;
    runner.register("slow", (_p, ctx) => {
      return new Promise((resolve, reject) => {
        release = () => resolve("finished");
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }, { onCancelled: (_p, id) => void cancelled.push(id) });

    const queued = runner.enqueue("slow", {}, { runAfter: clock + 60_000 });
    await runner.cancel(queued);
    expect(row(queued).status).toBe("cancelled");

    const running = runner.enqueue("slow");
    const ticking = runner.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(row(running).status).toBe("running");
    await runner.cancel(running);
    await ticking;
    expect(row(running).status).toBe("cancelled");
    expect(cancelled).toEqual([queued, running]);

    runner.retry(running);
    expect(row(running)).toMatchObject({ status: "queued", attempts: 0 });
    const t = runner.tick();
    await new Promise((r) => setTimeout(r, 5));
    release();
    await t;
    expect(row(running).status).toBe("done");
  });

  it("re-queues jobs a crash left running", async () => {
    const id = runner.enqueue("x");
    db.update(jobs).set({ status: "running", attempts: 1 }).where(eq(jobs.id, id)).run();
    runner.register("x", async () => "ok");
    runner.start();
    await runner.stop();
    expect(["queued", "done", "running"]).toContain(row(id).status);
    await runner.drain();
    expect(row(id).status).toBe("done");
  });

  it("lets a job invoke another handler as a step", async () => {
    runner.register("step", async (p: { v: number }) => p.v + 1);
    runner.register("outer", async (_p, ctx) => ({ got: await ctx.invoke("step", { v: 1 }) }));
    const id = runner.enqueue("outer");
    await runner.drain();
    expect(row(id).result).toEqual({ got: 2 });
  });
});

describe("jobs API", () => {
  let f: Family;
  beforeEach(async () => {
    f = await family();
  });
  afterEach(async () => {
    await f.close();
  });

  it("is admin-only", async () => {
    for (const who of ["parent", "adult", "kid"] as const) {
      expect((await f.app.inject({ url: "/api/admin/jobs", headers: f.as(who) })).statusCode).toBe(403);
    }
    expect((await f.app.inject({ url: "/api/admin/jobs" })).statusCode).toBe(401);
  });

  it("lists jobs with counts, shows logs, retries and cancels", async () => {
    f.app.jobs.register("test.fail", async () => {
      throw new PermanentJobError("nope");
    });
    const failed = f.app.jobs.enqueue("test.fail", {}, { label: "Failing" });
    const queued = f.app.jobs.enqueue("test.never", {});
    await f.app.jobs.drain();

    const list = await f.app.inject({ url: "/api/admin/jobs", headers: f.as("admin") });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 2, counts: { failed: 1, queued: 1 } });
    expect(list.json().types).toContain("library.scan");
    expect(list.json().types).toContain("downloads.fetch");

    const only = await f.app.inject({ url: "/api/admin/jobs?status=failed", headers: f.as("admin") });
    expect(only.json().items.map((j: { id: string }) => j.id)).toEqual([failed]);

    const one = await f.app.inject({ url: `/api/admin/jobs/${failed}`, headers: f.as("admin") });
    expect(one.json()).toMatchObject({ status: "failed", lastError: "nope", label: "Failing" });
    expect(one.json().logs[0]).toMatchObject({ level: "error", message: "nope" });

    const retry = await f.app.inject({ method: "POST", url: `/api/admin/jobs/${failed}/retry`, headers: f.as("admin") });
    expect(retry.json()).toMatchObject({ status: "queued", attempts: 0 });
    expect((await f.app.inject({ method: "POST", url: `/api/admin/jobs/${queued}/retry`, headers: f.as("admin") })).statusCode).toBe(409);

    const cancel = await f.app.inject({ method: "POST", url: `/api/admin/jobs/${queued}/cancel`, headers: f.as("admin") });
    expect(cancel.json().status).toBe("cancelled");
    expect((await f.app.inject({ url: "/api/admin/jobs/nope", headers: f.as("admin") })).statusCode).toBe(404);
  });
});
