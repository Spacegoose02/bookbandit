/**
 * Performance check: 20,000 books, then time the requests a family makes most.
 *
 *   pnpm --filter @bookbandit/server build
 *   pnpm --filter @bookbandit/e2e perf            # PERF_BOOKS=50000 for a bigger library
 *
 * Writes the books straight into a fresh SQLite database (no files: list, search and shelves only
 * read the database), starts the built server against it and measures each request 25 times after
 * a warm-up. Fails when any p95 is over PERF_BUDGET_MS (default 200).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const N = Number(process.env.PERF_BOOKS ?? 20_000);
const BUDGET = Number(process.env.PERF_BUDGET_MS ?? 200);
const PORT = Number(process.env.PERF_PORT ?? 18766);
const RUNS = 25;
const DIR = join(import.meta.dirname, "..", ".run", "perf");

const RATINGS = ["kids", "middle_grade", "teen", "adult", "explicit", null] as const;
const WORDS = "dragon moon river shadow garden secret silver winter ember harbor forest lantern crown storm whisper puzzle rocket meadow castle comet".split(" ");
const pick = <T>(a: readonly T[], i: number) => a[i % a.length]!;

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const configDir = join(DIR, "config");
  const t0 = Date.now();
  await seed(configDir);
  console.log(`seeded ${N.toLocaleString()} books in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const server = spawn(process.execPath, [join(ROOT, "apps/server/dist/index.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      CONFIG_DIR: configDir,
      BOOKS_DIR: join(DIR, "books"),
      WEB_DIR: join(DIR, "no-web"),
      METADATA_ONLINE: "false",
      LIBRARY_SCAN_ON_START: "false",
      BACKUP_TIME: "off",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    for (let i = 0; i < 150; i++) {
      if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const login = async (username: string) => {
      const r = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "perf-password-1" }),
      });
      if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
      return ((await r.json()) as { token: string }).token;
    };
    const adult = await login("parent");
    const admin = await login("admin");
    const kidRes = await fetch(`${base}/api/auth/kid-sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adult}` },
      body: JSON.stringify({ userId: KID_ID, pin: "1357" }),
    });
    if (!kidRes.ok) throw new Error(`kid sign-in: ${kidRes.status} ${await kidRes.text()}`);
    const kid = ((await kidRes.json()) as { token: string }).token;

    const cases: [string, string, string][] = [
      ["list (newest)", "/api/books?limit=60", adult],
      ["list (title)", "/api/books?limit=60&sort=title", adult],
      ["list page 200", "/api/books?limit=60&offset=12000", adult],
      ["list (kid)", "/api/books?limit=60", kid],
      ["search title", "/api/books?q=silver%20lantern&limit=60", adult],
      ["search author", "/api/books?q=Author%2042&limit=60", adult],
      ["search (kid)", "/api/books?q=dragon&limit=60", kid],
      ["home shelves", "/api/shelves", adult],
      ["home shelves (kid)", "/api/shelves", kid],
      ["continue reading", "/api/shelves/continue", adult],
      ["authors", "/api/authors", adult],
      ["series list", "/api/series", adult],
      ["one book", `/api/books/${SAMPLE_BOOK}`, adult],
      ["OPDS new", "/opds/new", adult],
      ["admin overview", "/api/admin/overview", admin],
    ];
    const rows: { name: string; p50: number; p95: number; max: number; status: number }[] = [];
    for (const [name, path, token] of cases) {
      const times: number[] = [];
      let status = 0;
      for (let i = 0; i < RUNS + 3; i++) {
        const s = performance.now();
        const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
        await r.arrayBuffer();
        status = r.status;
        if (i >= 3) times.push(performance.now() - s);
      }
      times.sort((a, b) => a - b);
      const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!;
      rows.push({ name, p50: q(0.5), p95: q(0.95), max: times.at(-1)!, status });
    }
    const over = rows.filter((r) => r.p95 > BUDGET || r.status !== 200);
    const table = [
      `| Request (${N.toLocaleString()} books) | p50 ms | p95 ms | status |`,
      "| --- | ---: | ---: | ---: |",
      ...rows.map((r) => `| ${r.name} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.status} |`),
    ].join("\n");
    console.log(table);
    writeFileSync(join(DIR, "results.md"), table + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Library performance\n\n${table}\n`, { flag: "a" });
    if (over.length) {
      console.error(`Over the ${BUDGET} ms budget (or not 200): ${over.map((r) => r.name).join(", ")}`);
      process.exitCode = 1;
    }
  } finally {
    server.kill("SIGTERM");
  }
}

let KID_ID = "";
let SAMPLE_BOOK = "";

async function seed(configDir: string) {
  const dist = (p: string) => import(pathToFileURL(join(ROOT, "apps/server/dist", p)).href);
  const { openDb, dbPath } = await dist("db/client.js");
  const s = await dist("db/schema.js");
  const { hashSecret } = await dist("auth/secrets.js");
  const { db, close } = openDb(dbPath(configDir));
  const hash = await hashSecret("perf-password-1");
  const pinHash = await hashSecret("1357");

  const [home] = db.insert(s.households).values({ name: "Perf" }).returning().all();
  const [fam] = db.insert(s.families).values({ householdId: home.id, name: "Perf" }).returning().all();
  const user = (displayName: string, role: string, extra: object = {}) =>
    db.insert(s.users).values({ householdId: home.id, familyId: fam.id, displayName, role, secretHash: hash, ...extra }).returning().all()[0];
  const admin = user("Admin", "admin");
  const parent = user("Parent", "parent");
  const kid = user("Kid", "kid", { birthYear: new Date().getUTCFullYear() - 9, kidSignInMethod: "pin", secretHash: pinHash });
  KID_ID = kid.id;
  db.insert(s.userIdentities).values([
    { userId: admin.id, provider: "local", subject: "admin" },
    { userId: parent.id, provider: "local", subject: "parent" },
  ]).run();
  db.insert(s.parentLinks).values({ parentId: parent.id, kidId: kid.id }).run();

  const authorIds: string[] = [];
  db.transaction((tx: any) => {
    for (let a = 0; a < 2_000; a++) {
      authorIds.push(tx.insert(s.authors).values({ name: `Author ${a}`, sortName: `${a}, Author` }).returning({ id: s.authors.id }).all()[0].id);
    }
  });
  const seriesIds: string[] = [];
  const tagIds: string[] = [];
  db.transaction((tx: any) => {
    for (let i = 0; i < 800; i++) seriesIds.push(tx.insert(s.series).values({ name: `Saga ${i}` }).returning({ id: s.series.id }).all()[0].id);
    for (const w of WORDS) tagIds.push(tx.insert(s.tags).values({ name: `Genre ${w}`, kind: "genre" }).returning({ id: s.tags.id }).all()[0].id);
  });

  const now = Date.now();
  const CHUNK = 1000;
  for (let start = 0; start < N; start += CHUNK) {
    db.transaction((tx: any) => {
      for (let i = start; i < Math.min(N, start + CHUNK); i++) {
        const title = `The ${pick(WORDS, i)} ${pick(WORDS, Math.floor(i / 7))} ${i}`;
        const [b] = tx
          .insert(s.books)
          .values({
            title,
            sortTitle: title.toLowerCase().replace(/^the /, ""),
            description: `A story about ${pick(WORDS, i * 3)} and ${pick(WORDS, i * 5)}.`,
            publishedYear: 1950 + (i % 75),
            rating: pick(RATINGS, i),
            approved: i % 50 !== 0,
            addedAt: now - i * 60_000,
          })
          .returning({ id: s.books.id })
          .all();
        if (i === 123) SAMPLE_BOOK = b.id;
        tx.insert(s.bookAuthors).values({ bookId: b.id, authorId: pick(authorIds, i) }).run();
        tx.insert(s.bookFiles)
          .values({ bookId: b.id, relPath: `perf/${i}.epub`, format: "epub", sizeBytes: 300_000, sha256: `perf-${i}`, mtimeMs: now })
          .run();
        tx.insert(s.bookTags).values({ bookId: b.id, tagId: pick(tagIds, i) }).run();
        if (i % 4 === 0) tx.insert(s.bookSeries).values({ bookId: b.id, seriesId: pick(seriesIds, i / 4), position: Math.floor(i / 3200) + 1 }).run();
        if (i % 400 === 0) {
          tx.insert(s.readingProgress)
            .values({
              userId: parent.id,
              bookId: b.id,
              locator: { kind: "epub", cfi: "epubcfi(/6/4!/4/2)", percent: 0.3 },
              percent: 0.3,
              finished: false,
              deviceName: "perf",
              clientUpdatedAt: now - i,
              serverUpdatedAt: now - i,
            })
            .run();
        }
      }
    });
  }
  close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
