/**
 * Builds a throwaway family library and starts the real server against it:
 *
 * 1. EPUB files under .run/books in rating folders (kids/, teen/, adult/, explicit/, unsorted/).
 * 2. A fake OpenAI-compatible model server for Barnaby.
 * 3. `node apps/server/dist/index.js` with its own CONFIG_DIR, serving apps/web/dist.
 * 4. Everything else through the public API, the way a family would: first-run setup, scan,
 *    approve the inbox, add Dad and 7-year-old Emma, pair a tablet, e-reader sign-ins, Barnaby.
 *
 * Needs `pnpm --filter @bookbandit/shared build && pnpm --filter @bookbandit/server build &&
 * pnpm --filter @bookbandit/web build` first.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FullConfig } from "@playwright/test";
import { writeEpub } from "./epub.js";
import { startFakeAi } from "./fake-ai.js";
import { BOOKS, type BookKey } from "./library.js";
import { RUN_DIR, STATE_FILE, type World } from "./state.js";

const ROOT = resolve(import.meta.dirname, "../..");
export const PORT = Number(process.env.E2E_PORT ?? 18765);

export default async function globalSetup(_config: FullConfig) {
  const serverEntry = join(ROOT, "apps/server/dist/index.js");
  const webDir = join(ROOT, "apps/web/dist");
  for (const p of [serverEntry, join(webDir, "index.html")]) {
    if (!existsSync(p)) throw new Error(`${p} is missing. Build first: pnpm --filter @bookbandit/server build && pnpm --filter @bookbandit/web build`);
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  const booksDir = join(RUN_DIR, "books");
  const configDir = join(RUN_DIR, "config");
  mkdirSync(configDir, { recursive: true });
  const relPaths = {} as Record<BookKey, string>;
  for (const [key, b] of Object.entries(BOOKS) as [BookKey, (typeof BOOKS)[BookKey]][]) {
    relPaths[key] = `${b.folder}/${b.author}/${b.author} - ${b.title}.epub`;
    await writeEpub(join(booksDir, relPaths[key]), { title: b.title, author: b.author, chapters: b.chapters, id: `00000000-0000-4000-8000-${String(Object.keys(BOOKS).indexOf(key)).padStart(12, "0")}` });
  }

  const ai = await startFakeAi();
  const baseURL = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      CONFIG_DIR: configDir,
      BOOKS_DIR: booksDir,
      WEB_DIR: webDir,
      METADATA_ONLINE: "false",
      LIBRARY_SCAN_ON_START: "true",
      BACKUP_TIME: "off",
      TRUSTED_PROXIES: "",
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const stop = () => killServer(server);
  try {
    await waitForHealth(baseURL, server);
    const w = await seed(baseURL, `http://127.0.0.1:${ai.port}`, booksDir, relPaths);
    writeFileSync(STATE_FILE, JSON.stringify(w, null, 2));
  } catch (err) {
    stop();
    ai.server.close();
    throw err;
  }
  return async () => {
    stop();
    ai.server.close();
  };
}

function killServer(p: ChildProcess) {
  if (p.exitCode == null) p.kill("SIGTERM");
}

async function waitForHealth(baseURL: string, p: ChildProcess) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (p.exitCode != null) throw new Error(`The server exited with code ${p.exitCode}`);
    try {
      const r = await fetch(`${baseURL}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The server didn't answer /api/health within 30 s");
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function seed(baseURL: string, aiURL: string, booksDir: string, relPaths: Record<BookKey, string>): Promise<World> {
  const call = async (method: string, path: string, body?: unknown, token?: string): Promise<Json> => {
    const res = await fetch(baseURL + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };

  // First run: the admin.
  const admin = { username: "admin", password: "admin-password-123" };
  const setup = await call("POST", "/api/auth/setup", { householdName: "The Testers", displayName: "Alex", ...admin });
  const adminToken: string = setup.token;

  // The startup scan, then approve everything but the inbox book.
  const until = Date.now() + 60_000;
  let scan: Json;
  for (;;) {
    scan = await call("GET", "/api/admin/library/scan", undefined, adminToken);
    if (!scan.running && scan.lastReport) break;
    if (!scan.running && !scan.lastReport) await call("POST", "/api/admin/library/scan", {}, adminToken).catch(() => {});
    if (Date.now() > until) throw new Error("The library scan didn't finish");
    await new Promise((r) => setTimeout(r, 250));
  }
  const inbox: Json = await call("GET", "/api/admin/inbox?limit=100", undefined, adminToken);
  const byTitle = new Map<string, string>(inbox.items.map((i: Json) => [i.title, i.id]));
  const ids = {} as Record<BookKey, string>;
  for (const [key, b] of Object.entries(BOOKS) as [BookKey, (typeof BOOKS)[BookKey]][]) {
    const id = byTitle.get(b.title);
    if (!id) throw new Error(`"${b.title}" didn't reach the inbox (got ${[...byTitle.keys()].join(", ")})`);
    ids[key] = id;
  }
  const approve = (Object.keys(ids) as BookKey[]).filter((k) => k !== "inbox").map((k) => ids[k]);
  await call("POST", "/api/admin/inbox/approve", { ids: approve }, adminToken);

  const books = {} as World["books"];
  for (const key of Object.keys(ids) as BookKey[]) {
    const detail: Json = await call("GET", `/api/admin/books/${ids[key]}`, undefined, adminToken);
    const rating = detail.rating ?? detail.book?.rating ?? null;
    const expected = { kids: "kids", kidsTwo: "kids", teen: "teen", adult: "adult", explicit: "explicit", unrated: null, inbox: "kids" }[key];
    if (rating !== expected) throw new Error(`"${BOOKS[key].title}" is rated ${rating}, expected ${expected}`);
    const files: Json[] = detail.files ?? detail.book?.files ?? [];
    if (!files[0]) throw new Error(`"${BOOKS[key].title}" has no file`);
    books[key] = { id: ids[key], fileId: files[0].id, title: BOOKS[key].title, relPath: relPaths[key] };
  }

  // Dad (a parent with a password) and Emma (7, signs in with a PIN).
  const dadLogin = { username: "dad", password: "dad-password-123" };
  const dadUser: Json = await call("POST", "/api/users", { displayName: "Dad", role: "parent", ...dadLogin }, adminToken);
  const dadToken: string = (await call("POST", "/api/auth/login", dadLogin)).token;
  const emmaPin = "2468";
  const emmaUser: Json = await call(
    "POST",
    "/api/users",
    { displayName: "Emma", role: "kid", birthYear: new Date().getUTCFullYear() - 7, kidSignInMethod: "pin", pin: emmaPin },
    dadToken,
  );
  const emmaToken: string = (await call("POST", "/api/auth/kid-sign-in", { userId: emmaUser.id, pin: emmaPin }, dadToken)).token;

  // A shared family tablet.
  const pairing: Json = await call("POST", "/api/devices/pairings", { name: "Family tablet" }, dadToken);
  const claimed: Json = await call("POST", "/api/devices/claim", { code: pairing.code, name: "Family tablet" });

  // E-reader sign-ins, made by Dad for himself and for Emma.
  const login = async (userId: string | undefined, name: string) => {
    const l: Json = await call("POST", "/api/ereader/credentials", { kind: "login", name, ...(userId ? { userId } : {}) }, dadToken);
    const k: Json = await call("POST", "/api/ereader/credentials", { kind: "kobo", name: `${name} Kobo`, ...(userId ? { userId } : {}) }, dadToken);
    return { username: l.username as string, password: l.password as string, koboToken: k.token as string };
  };
  const ereader = { emma: await login(emmaUser.id, "Emma's Kobo"), dad: await login(undefined, "Dad's Kobo") };

  // Barnaby on the fake model; Dad turns it on for Emma.
  await call(
    "PUT",
    "/api/admin/ai/settings",
    {
      providers: [{ id: "fake", name: "Fake model", kind: "openai", baseUrl: `${aiURL}/v1`, model: "fake-model", apiKey: "not-a-real-key" }],
      features: { chat: "fake", kidChat: "fake", bookChat: "fake", moderation: null, rating: null },
    },
    adminToken,
  );
  await call("PUT", `/api/ai/kids/${emmaUser.id}/settings`, { enabled: true, webSearch: false, dailyLimit: 100 }, dadToken);

  // A series and a category that mix every rating.
  const series: Json = await call(
    "POST",
    "/api/series",
    { name: "The Mixed Shelf", books: (Object.keys(ids) as BookKey[]).map((k) => ({ bookId: ids[k] })) },
    adminToken,
  );
  const category: Json = await call("POST", "/api/categories", { name: "Mixed Bag", kind: "custom" }, adminToken);
  await call("PUT", `/api/categories/${category.id}/books`, { add: Object.values(ids) }, adminToken);

  return {
    baseURL,
    aiURL,
    booksDir,
    admin: { id: setup.user.id, ...admin, token: adminToken },
    dad: { id: dadUser.id, ...dadLogin, token: dadToken },
    emma: { id: emmaUser.id, pin: emmaPin, token: emmaToken },
    tablet: { deviceToken: claimed.deviceToken },
    books,
    ereader,
    seriesId: series.id,
    categoryId: category.id,
  };
}
