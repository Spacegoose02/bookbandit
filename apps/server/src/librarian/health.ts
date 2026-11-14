/**
 * Library health: what needs a librarian's attention.
 *
 * - Database checks run live: books with no cover, no rating, no author, and books whose files
 *   are all gone (Kindle-only entries don't count).
 * - File checks run on the job runner (`librarian.health`) because they open every file: missing
 *   on disk, unreadable (empty, not a zip, no OPF, bad PDF/MOBI header), DRM-protected. The last
 *   report is kept in the settings table.
 */
import { open, stat } from "node:fs/promises";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookAuthors, bookFiles, books, settings } from "../db/schema.js";
import type { JobRunner } from "../jobs/index.js";
import { isDrmProtected } from "../library/drm.js";
import type { BookFormat } from "../library/formats.js";
import { insideRoot } from "../library/serve.js";
import { openZip } from "../metadata/zip.js";

export const HEALTH_JOB = "librarian.health";
const REPORT_KEY = "librarian.health";

export const HEALTH_CHECKS = ["no_cover", "no_rating", "no_author", "no_files"] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];

export interface FileProblem {
  fileId: string;
  bookId: string;
  title: string;
  relPath: string;
  format: string;
  problem: "missing" | "unreadable" | "drm";
  detail?: string;
}

export interface FileReport {
  checkedAt: number;
  filesChecked: number;
  problems: FileProblem[];
}

export function healthWhere(check: HealthCheck) {
  switch (check) {
    case "no_cover":
      return isNull(books.coverPath);
    case "no_rating":
      return and(isNull(books.rating), eq(books.kindleOnly, false));
    case "no_author":
      return sql`not exists (select 1 from ${bookAuthors} where ${bookAuthors.bookId} = ${books.id})`;
    case "no_files":
      return and(eq(books.kindleOnly, false), sql`not exists (select 1 from ${bookFiles} where ${bookFiles.bookId} = ${books.id})`);
  }
}

export function healthCounts(db: Db): Record<HealthCheck, number> {
  const out = {} as Record<HealthCheck, number>;
  for (const c of HEALTH_CHECKS) {
    out[c] = db.select({ n: sql<number>`count(*)` }).from(books).where(healthWhere(c)).get()?.n ?? 0;
  }
  return out;
}

export function lastFileReport(db: Db): FileReport | null {
  const row = db.select().from(settings).where(eq(settings.key, REPORT_KEY)).get();
  return (row?.value as FileReport | undefined) ?? null;
}

/** Why a file can't be opened, or null when it looks fine. */
export async function fileProblem(abs: string, format: BookFormat): Promise<string | null> {
  const s = await stat(abs);
  if (!s.size) return "The file is empty";
  const head = Buffer.alloc(1024);
  const fh = await open(abs, "r");
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  switch (format) {
    case "epub":
    case "kepub":
    case "cbz": {
      if (head.subarray(0, 2).toString("latin1") !== "PK") return "Not a zip archive";
      const zip = await openZip(abs).catch(() => null);
      if (!zip) return "The zip archive is damaged";
      try {
        if (format !== "cbz" && !zip.names.some((n) => n.toLowerCase().endsWith(".opf"))) return "No OPF package document inside";
        if (format === "cbz" && !zip.names.some((n) => /\.(jpe?g|png|webp|gif|avif)$/i.test(n))) return "No pages inside";
      } finally {
        zip.close();
      }
      return null;
    }
    case "pdf":
      return head.subarray(0, 1024).includes("%PDF") ? null : "Not a PDF (no %PDF header)";
    case "mobi":
    case "azw3":
      return head.subarray(60, 68).toString("latin1") === "BOOKMOBI" ? null : "Not a MOBI/AZW3 (no BOOKMOBI header)";
    default:
      return null;
  }
}

export function registerHealthJob(runner: JobRunner, deps: { db: Db; booksRoot: string }): void {
  const { db, booksRoot } = deps;
  runner.register(
    HEALTH_JOB,
    async (_p, ctx) => {
      const files = db
        .select({ fileId: bookFiles.id, bookId: bookFiles.bookId, title: books.title, relPath: bookFiles.relPath, format: bookFiles.format })
        .from(bookFiles)
        .innerJoin(books, eq(books.id, bookFiles.bookId))
        .orderBy(asc(bookFiles.relPath))
        .all();
      const problems: FileProblem[] = [];
      let done = 0;
      for (const f of files) {
        if (ctx.signal.aborted) break;
        const abs = insideRoot(booksRoot, f.relPath);
        const exists = abs ? await stat(abs).then((s) => s.isFile(), () => false) : false;
        if (!abs || !exists) problems.push({ ...f, problem: "missing" });
        else {
          const why = await fileProblem(abs, f.format).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
          if (why) problems.push({ ...f, problem: "unreadable", detail: why });
          else if (await isDrmProtected(abs, f.format)) problems.push({ ...f, problem: "drm" });
        }
        if (++done % 25 === 0) ctx.progress(done / files.length);
      }
      const report: FileReport = { checkedAt: Date.now(), filesChecked: done, problems };
      db.insert(settings)
        .values({ key: REPORT_KEY, value: report, updatedAt: report.checkedAt })
        .onConflictDoUpdate({ target: settings.key, set: { value: report, updatedAt: report.checkedAt } })
        .run();
      ctx.log(`Checked ${done} files: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
      return { filesChecked: done, problems: problems.length };
    },
    { maxAttempts: 1 },
  );
}

/** Drop problems for files that were fixed or removed since the report (the report is a snapshot). */
export function currentProblems(db: Db, report: FileReport | null): FileProblem[] {
  if (!report?.problems.length) return [];
  const ids = report.problems.map((p) => p.fileId);
  const still = new Set(db.select({ id: bookFiles.id }).from(bookFiles).where(inArray(bookFiles.id, ids)).all().map((r) => r.id));
  return report.problems.filter((p) => still.has(p.fileId));
}
