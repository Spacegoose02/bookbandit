/**
 * Reads an audiobook folder: durations, tags, cover and chapters.
 *
 * Chapters, best first: M4B chapter atoms (one file with chapters inside), then one chapter per
 * file named from its title tag or file name. Book metadata comes from the tags of the first
 * file (album = title, album artist / artist = author, composer or narrator tag = narrator),
 * falling back to the folder names (Author/Title, or Author/Series/Title).
 */
import { readFile } from "node:fs/promises";
import { parseFile, type IAudioMetadata } from "music-metadata";
import { NON_AUTHOR_DIRS } from "../metadata/rating.js";
import type { FileMetadata } from "../metadata/types.js";
import type { LocalChapter, LocalTrack } from "./schema.js";
import { readMp4Chapters, type RawChapter } from "./mp4chapters.js";
import { AUDIO_TYPES, audioExt, type AudiobookUnit } from "./walk.js";

export interface ProbedAudiobook {
  tracks: LocalTrack[];
  chapters: LocalChapter[];
  duration: number;
  narrator: string | null;
  metadata: FileMetadata;
  errors: string[];
}

type Parse = (path: string, opts: { duration?: boolean; skipCovers?: boolean; includeChapters?: boolean }) => Promise<IAudioMetadata>;

const IMAGE_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** "03 - The Den.mp3" → "The Den"; "Chapter 3.mp3" stays. */
export function titleFromFileName(relPath: string): string {
  const base = relPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  const stripped = base
    .replace(/^\s*(track|trk)?\s*\d{1,4}\s*[-_.)\]]\s*/i, "")
    .replace(/[_]+/g, " ")
    .trim();
  return stripped || base;
}

/** Book metadata from the folder layout: Author/Title or Author/Series/Title. */
export function metadataFromPath(relPath: string): { title: string; author?: string; series?: string; seriesPosition?: number } {
  const all = relPath.split("/");
  // Rating and sorting folders ("kids/", "adult/", "audiobooks/") aren't authors or series.
  let skip = 0;
  while (skip < all.length - 1 && (NON_AUTHOR_DIRS.has(all[skip]!.toLowerCase()) || /^audio ?books?$/i.test(all[skip]!))) skip++;
  const parts = all.slice(skip);
  let titlePart = parts[parts.length - 1]!;
  if (all.length === 1) titlePart = titlePart.replace(/\.[^.]+$/, ""); // loose file
  let title = titlePart.replace(/[_]+/g, " ").trim();
  let seriesPosition: number | undefined;
  // "Book 2 - Title", "02 - Title", "Vol. 3 - Title"
  const pos = title.match(/^(?:book|vol\.?|volume)?\s*(\d+(?:\.\d+)?)\s*[-–.:]\s+(.+)$/i);
  if (pos) {
    seriesPosition = Number(pos[1]);
    title = pos[2]!.trim();
  }
  // "Title (2001)" / "Title [Unabridged]"
  title = title.replace(/\s*[[(](\d{4}|unabridged|abridged)[\])]\s*$/i, "").trim();
  const author = parts.length >= 2 ? parts[0] : undefined;
  const series = parts.length >= 3 ? parts[parts.length - 2] : undefined;
  return { title, author, series, seriesPosition };
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) return v.map(firstString).find(Boolean);
  return undefined;
}

function nativeTag(meta: IAudioMetadata, ids: string[]): string | undefined {
  for (const tags of Object.values(meta.native ?? {})) {
    for (const t of tags) {
      if (ids.includes(t.id.toUpperCase())) {
        const v = typeof t.value === "string" ? t.value : (t.value as { text?: string })?.text;
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return undefined;
}

function toChapters(raw: RawChapter[], duration: number): LocalChapter[] {
  const sorted = raw.filter((c) => Number.isFinite(c.start) && c.start < duration).sort((a, b) => a.start - b.start);
  return sorted.map((c, i) => ({
    start: c.start,
    end: i + 1 < sorted.length ? sorted[i + 1]!.start : duration,
    title: c.title || `Chapter ${i + 1}`,
  }));
}

export async function probeAudiobook(unit: AudiobookUnit, opts: { parse?: Parse } = {}): Promise<ProbedAudiobook> {
  const parse: Parse = opts.parse ?? ((p, o) => parseFile(p, o));
  const errors: string[] = [];
  const tracks: LocalTrack[] = [];
  let first: IAudioMetadata | undefined;
  const fileChapters: RawChapter[] = [];
  let offset = 0;

  for (const [i, f] of unit.files.entries()) {
    let meta: IAudioMetadata | undefined;
    try {
      meta = await parse(f.absPath, { duration: false, skipCovers: i > 0, includeChapters: true });
      if (meta.format.duration == null) meta = await parse(f.absPath, { duration: true, skipCovers: true });
    } catch (err) {
      errors.push(`${f.relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const duration = meta?.format.duration ?? 0;
    if (duration <= 0) {
      if (meta) errors.push(`${f.relPath}: no duration`);
      continue; // unplayable: leave it out rather than break the timeline
    }
    first ??= meta;
    const ext = audioExt(f.relPath)!;
    tracks.push({
      relPath: f.relPath,
      duration,
      startOffset: offset,
      mimeType: AUDIO_TYPES[ext]!,
      sizeBytes: f.sizeBytes,
      mtimeMs: f.mtimeMs,
      title: meta?.common.title?.trim() || titleFromFileName(f.relPath),
    });

    // Chapters inside the file (M4B), shifted to the book timeline.
    let inner: RawChapter[] = [];
    if (ext === "m4b" || ext === "m4a" || ext === "mp4") {
      inner = await readMp4Chapters(f.absPath).catch(() => []);
    }
    if (!inner.length && meta?.format.chapters?.length) {
      inner = meta.format.chapters.map((c) => ({
        start: c.timeScale ? c.start / c.timeScale : c.start,
        title: c.title,
      }));
    }
    for (const c of inner) fileChapters.push({ start: offset + c.start, title: c.title });
    offset += duration;
  }

  const duration = offset;
  const chapters =
    fileChapters.length > 1 || (fileChapters.length === 1 && tracks.length === 1)
      ? toChapters(fileChapters, duration)
      : tracks.map((t) => ({ start: t.startOffset, end: t.startOffset + t.duration, title: t.title }));

  const fromPath = metadataFromPath(unit.relPath);
  const c = first?.common;
  const album = c?.album?.trim();
  const author = c?.albumartist?.trim() || c?.artist?.trim() || fromPath.author;
  const narrator =
    firstString(c?.composer) ?? (first ? nativeTag(first, ["NARRATOR", "©NRT", "TXXX:NARRATOR", "----:COM.APPLE.ITUNES:NARRATOR"]) : undefined) ?? null;
  const isbn = first ? nativeTag(first, ["ISBN", "TXXX:ISBN", "----:COM.APPLE.ITUNES:ISBN"]) : undefined;
  const isbn13 = isbn?.replace(/[^0-9Xx]/g, "");

  const metadata: FileMetadata = {
    title: album || (unit.files.length === 1 ? c?.title?.trim() : undefined) || fromPath.title,
    authors: author ? author.split(/\s*(?:;|&|\band\b)\s*/).filter(Boolean) : undefined,
    description: firstString(c?.description) ?? firstString(c?.comment?.map((x) => x.text)),
    publishedYear: c?.year && c.year > 1000 ? c.year : undefined,
    publisher: firstString(c?.label),
    language: firstString(c?.language),
    subjects: c?.genre?.filter((g) => !/^(audio ?book|speech|spoken)/i.test(g)),
    series: fromPath.series,
    seriesPosition: fromPath.seriesPosition,
    isbn13: isbn13 && isbn13.length === 13 ? isbn13 : undefined,
  };

  const pic = c?.picture?.[0];
  if (pic?.data?.length) metadata.cover = { data: Buffer.from(pic.data), mime: pic.format.toLowerCase() === "image/jpg" ? "image/jpeg" : pic.format.toLowerCase() };
  return { tracks, chapters, duration, narrator, metadata, errors };
}

/** A folder cover image, as a Cover for saveCover. */
export async function readCoverFile(absPath: string): Promise<{ data: Buffer; mime: string } | undefined> {
  const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_MIME[ext];
  if (!mime) return undefined;
  const data = await readFile(absPath).catch(() => undefined);
  return data?.length ? { data, mime } : undefined;
}
