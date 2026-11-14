/**
 * Where downloads and uploads land: BOOKS_DIR/_incoming/<kind>/<id>/<file>.
 *
 * Files are written under BOOKS_DIR/_incoming/.partial/ first (hidden, so a scan running at the
 * same time never picks up half a file) and renamed into place when complete. The library scan
 * then adds them to the admin inbox like any other new file.
 */
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatForPath } from "../library/formats.js";
import { openZip } from "../metadata/zip.js";

export const INCOMING = "_incoming";
export type IncomingKind = "requests" | "direct" | "uploads" | "sabnzbd";

/** Relative (to BOOKS_DIR) folder for one download, with forward slashes. */
export function incomingRel(kind: IncomingKind, id: string): string {
  return `${INCOMING}/${kind}/${safeSegment(id)}`;
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 100) || "_";
}

/** A file name that can't escape its folder or hide itself. Keeps the extension. */
export function safeFilename(name: string, fallback = "book"): string {
  const base = basename(name.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!base) return fallback;
  if (base.length <= 180) return base;
  const ext = extname(base).slice(0, 20);
  return base.slice(0, 180 - ext.length) + ext;
}

export function isBookFile(name: string): boolean {
  return !!formatForPath(name);
}

export class TooLargeError extends Error {
  statusCode = 413;
}

/**
 * Stream `body` into a hidden temp file, refusing more than maxBytes.
 * Returns the temp path; call `publish()` to move it into place.
 */
export async function writeTemp(booksDir: string, body: Readable | ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal) {
  const dir = join(booksDir, INCOMING, ".partial");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, crypto.randomUUID());
  let total = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) cb(new TooLargeError(`File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
      else cb(null, chunk);
    },
  });
  const src = body instanceof Readable ? body : Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  try {
    await pipeline(src, limit, createWriteStream(tmp, { flags: "wx" }), { signal });
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { tmp, bytes: total };
}

/** Move a finished temp file to <booksDir>/<rel>/<name>, never overwriting. Returns the relative path. */
export async function publish(booksDir: string, tmp: string, rel: string, name: string): Promise<string> {
  const dir = join(booksDir, rel);
  await mkdir(dir, { recursive: true });
  const target = await freeName(dir, safeFilename(name));
  await rename(tmp, target);
  return relative(booksDir, target).split(sep).join("/");
}

async function freeName(dir: string, name: string): Promise<string> {
  const ext = name.toLowerCase().endsWith(".kepub.epub") ? ".kepub.epub" : extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i ? `${stem} (${i})${ext}` : name);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Too many files with the same name");
}

/**
 * Place a downloaded file. Book files go straight in; a .zip has its book files extracted
 * (Shelfmark zips multi-file downloads). Returns the relative paths of book files placed.
 */
export async function placeDownload(booksDir: string, tmp: string, rel: string, name: string): Promise<string[]> {
  if (isBookFile(name)) return [await publish(booksDir, tmp, rel, name)];
  if (extname(name).toLowerCase() === ".zip") {
    try {
      return await extractBooks(booksDir, tmp, rel);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  await rm(tmp, { force: true });
  throw new NotABookError(`${name} is not a book file Bookbandit can read`);
}

export class NotABookError extends Error {
  statusCode = 415;
}

const MAX_ENTRY = 2 * 1024 * 1024 * 1024 - 1;

async function extractBooks(booksDir: string, zipPath: string, rel: string): Promise<string[]> {
  const zip = await openZip(zipPath);
  const placed: string[] = [];
  try {
    for (const entry of zip.names) {
      if (entry.endsWith("/") || !isBookFile(entry)) continue;
      const data = await zip.read(entry, MAX_ENTRY);
      const { tmp } = await writeTemp(booksDir, Readable.from([data]), MAX_ENTRY);
      placed.push(await publish(booksDir, tmp, rel, entry));
    }
  } finally {
    zip.close();
  }
  if (!placed.length) throw new NotABookError("The archive has no book files in it");
  return placed;
}

/**
 * Copy the book files from a finished download folder (sabnzbd's completed dir) into the
 * library, recursing one folder tree. Returns the relative paths placed.
 */
export async function importFolder(booksDir: string, from: string, rel: string, maxFiles = 50): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || found.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && isBookFile(e.name)) found.push(p);
    }
  };
  const st = await stat(from);
  if (st.isFile()) found.push(from);
  else await walk(from, 0);
  const placed: string[] = [];
  for (const src of found) {
    if (!isBookFile(src)) continue;
    const dir = join(booksDir, INCOMING, ".partial");
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, crypto.randomUUID());
    await copyFile(src, tmp);
    placed.push(await publish(booksDir, tmp, rel, basename(src)));
  }
  return placed;
}

/** File name from a Content-Disposition header, if it has one. */
export function filenameFromDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  return (plain?.[2] ?? plain?.[1])?.trim() || undefined;
}

/** File name from a URL's last path segment. */
export function filenameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}
