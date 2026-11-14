/**
 * Reader-facing file serving: covers and book files. Both go through the content lock
 * (assertCanSee → 404 when locked or still in the inbox), like every book-returning endpoint.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { bookFiles, books } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import { assertCanSee, ContentLockedError } from "../content/lock.js";
import type { BookFormat } from "./formats.js";
import { isDrmProtected } from "./drm.js";

const Params = z.object({ id: z.string().min(1).max(64) });
const FileParams = Params.extend({ fileId: z.string().min(1).max(64) });

export const CONTENT_TYPES: Record<BookFormat, string> = {
  epub: "application/epub+zip",
  kepub: "application/epub+zip",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  fb2: "application/x-fictionbook+xml",
  pdf: "application/pdf",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  txt: "text/plain; charset=utf-8",
};

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

/** Absolute path for `rel` if it stays inside `root`, else undefined (guards against "../"). */
export function insideRoot(root: string, rel: string): string | undefined {
  const abs = resolve(root, rel);
  return abs === root || !abs.startsWith(root + sep) ? undefined : abs;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** Parses a single "bytes=a-b" range. Multi-range requests get the whole file. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return header.includes(",") ? undefined : "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix: last N bytes
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

export async function serveRoutes(app: FastifyInstance, opts: { db: Db; booksDir: string; configDir: string }) {
  const { db } = opts;
  const booksRoot = resolve(opts.booksDir);
  const configRoot = resolve(opts.configDir);

  function visibleBook(req: Parameters<typeof requireReader>[0], id: string) {
    const reader = requireReader(req);
    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);
    return book;
  }

  app.get("/api/books/:id/cover", async (req, reply) => {
    const { id } = parseOr404(Params, req.params);
    const book = visibleBook(req, id);
    const abs = book.coverPath ? insideRoot(configRoot, book.coverPath) : undefined;
    const ext = book.coverPath?.split(".").pop()?.toLowerCase() ?? "";
    const info = abs ? await stat(abs).catch(() => undefined) : undefined;
    if (!abs || !info?.isFile() || !IMAGE_TYPES[ext]) throw new ContentLockedError();
    // private: covers of locked books must not land in a shared cache.
    reply.header("cache-control", "private, max-age=86400");
    reply.header("content-length", info.size);
    reply.type(IMAGE_TYPES[ext]!);
    return reply.send(createReadStream(abs));
  });

  app.get("/api/books/:id/files/:fileId", async (req, reply) => {
    const { id, fileId } = parseOr404(FileParams, req.params);
    const book = visibleBook(req, id);
    const file = db
      .select()
      .from(bookFiles)
      .where(and(eq(bookFiles.id, fileId), eq(bookFiles.bookId, book.id)))
      .get();
    const abs = file ? insideRoot(booksRoot, file.relPath) : undefined;
    const info = abs ? await stat(abs).catch(() => undefined) : undefined;
    if (!file || !abs || !info?.isFile()) throw new ContentLockedError();
    if (await isDrmProtected(abs, file.format)) {
      throw httpError(409, "This file is DRM-protected and can't be opened here. Read it in the Kindle app.");
    }
    return sendFile(reply, abs, info.size, CONTENT_TYPES[file.format], downloadName(book.title, file.format), req.headers.range);
  });
}

export function sendFile(
  reply: FastifyReply,
  abs: string,
  size: number,
  type: string,
  filename: string,
  range: string | undefined,
  disposition: "inline" | "attachment" = "inline",
) {
  reply.header("accept-ranges", "bytes");
  reply.header("cache-control", "private, no-transform");
  reply.header("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  reply.type(type);
  const r = parseRange(range, size);
  if (r === "invalid") {
    reply.code(416).header("content-range", `bytes */${size}`);
    return reply.send();
  }
  if (r) {
    reply.code(206);
    reply.header("content-range", `bytes ${r.start}-${r.end}/${size}`);
    reply.header("content-length", r.end - r.start + 1);
    return reply.send(createReadStream(abs, { start: r.start, end: r.end }));
  }
  reply.header("content-length", size);
  return reply.send(createReadStream(abs));
}

export function downloadName(title: string, format: BookFormat): string {
  const ext = format === "kepub" ? "kepub.epub" : format;
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120) || "book";
  return `${safe}.${ext}`;
}

/** Bad ids look exactly like missing books: 404, never a 400 that hints at anything. */
function parseOr404<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ContentLockedError();
  return r.data;
}
