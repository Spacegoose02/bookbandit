import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
let close: () => void;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "bookbandit-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Bookbandit</title>");
  writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log('hi')");
  writeFileSync(join(webDir, "favicon.svg"), "<svg/>");
  const { db, close: c } = openDb(":memory:");
  close = c;
  app = await buildApp(loadConfig({ WEB_DIR: webDir, LOG_LEVEL: "error" } as NodeJS.ProcessEnv), db);
});

afterAll(async () => {
  await app.close();
  close();
  rmSync(webDir, { recursive: true, force: true });
});

describe("web app serving", () => {
  it("serves index.html at /", async () => {
    const res = await app.inject({ url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Bookbandit");
  });

  it("serves hashed assets with a long cache", async () => {
    const res = await app.inject({ url: "/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("falls back to index.html for client-side routes", async () => {
    const res = await app.inject({ url: "/books/123?tab=read" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toContain("Bookbandit");
  });

  it("keeps API routes working and unknown API routes as JSON 404", async () => {
    expect((await app.inject({ url: "/api/health" })).json()).toMatchObject({ ok: true });
    const res = await app.inject({ url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("404s missing files instead of returning the page", async () => {
    expect((await app.inject({ url: "/missing.png" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/books" })).statusCode).toBe(404);
  });
});

describe("without a web build", () => {
  it("still serves the API", async () => {
    const { db, close: c } = openDb(":memory:");
    const apiOnly = await buildApp(
      loadConfig({ WEB_DIR: join(webDir, "nope"), LOG_LEVEL: "error" } as NodeJS.ProcessEnv),
      db,
    );
    expect((await apiOnly.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await apiOnly.inject({ url: "/" })).statusCode).toBe(404);
    await apiOnly.close();
    c();
  });
});
