/**
 * Finds audiobooks under AUDIOBOOKS_DIR. The layout Audiobookshelf uses works as is:
 *
 *   Author/Title/01.mp3 …         one folder per book
 *   Author/Series/Title/book.m4b  any depth
 *   Title/CD 1/01.mp3, CD 2/…     disc folders belong to the book above them
 *   loose.m4b                     a single file at the top is a book of its own
 *
 * Hidden files and folders, Synology/Unraid recycle folders and symlinks are skipped.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4b: "audio/mp4",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
};

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const DISC_DIR = /^(cd|disc|disk|part|teil|vol(ume)?)[\s._-]*\d+\b/i;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function audioExt(name: string): string | undefined {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext && name.includes(".") && AUDIO_TYPES[ext] ? ext : undefined;
}

export interface AudioFile {
  /** Relative to the audiobooks root, forward slashes. */
  relPath: string;
  absPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface AudiobookUnit {
  /** The folder (or the loose file) relative to the root. */
  relPath: string;
  /** Audio files in play order. */
  files: AudioFile[];
  coverRelPath: string | null;
}

interface Listing {
  audio: AudioFile[];
  images: string[];
  dirs: { name: string; abs: string; rel: string }[];
}

async function list(dir: string, rel: string): Promise<Listing> {
  const out: Listing = { audio: [], images: [], dirs: [] };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable folder: skip it, don't fail the scan
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "@eaDir" || e.name === "#recycle") continue;
    const abs = join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.dirs.push({ name: e.name, abs, rel: relPath });
    else if (e.isFile()) {
      if (audioExt(e.name)) {
        try {
          const s = await stat(abs);
          if (s.size > 0) out.audio.push({ relPath, absPath: abs, sizeBytes: s.size, mtimeMs: Math.floor(s.mtimeMs) });
        } catch {
          // vanished mid-scan
        }
      } else if (IMAGE_EXT.test(e.name)) out.images.push(relPath);
    }
  }
  out.audio.sort((a, b) => collator.compare(a.relPath, b.relPath));
  out.dirs.sort((a, b) => collator.compare(a.name, b.name));
  out.images.sort((a, b) => collator.compare(a, b));
  return out;
}

/** cover.jpg / folder.jpg / front.jpg first, otherwise the only image there is. */
export function pickCover(images: string[]): string | null {
  const named = images.find((p) => /(^|\/)(cover|folder|front)\.(jpe?g|png|webp)$/i.test(p));
  if (named) return named;
  return images.length === 1 ? images[0]! : null;
}

export async function walkAudiobooks(root: string): Promise<AudiobookUnit[]> {
  const units: AudiobookUnit[] = [];

  async function visit(dir: string, rel: string, depth: number) {
    if (depth > 12) return;
    const here = await list(dir, rel);

    // Loose files at the top: each one is its own book.
    if (!rel) {
      for (const f of here.audio) units.push({ relPath: f.relPath, files: [f], coverRelPath: null });
      for (const d of here.dirs) await visit(d.abs, d.rel, depth + 1);
      return;
    }

    const discs = here.dirs.filter((d) => DISC_DIR.test(d.name));
    const discListings = await Promise.all(discs.map((d) => list(d.abs, d.rel)));
    const discAudio = discListings.flatMap((l) => l.audio);
    if (here.audio.length || discAudio.length) {
      const images = [...here.images, ...discListings.flatMap((l) => l.images)];
      units.push({ relPath: rel, files: [...here.audio, ...discAudio], coverRelPath: pickCover(images) });
      for (const d of here.dirs) if (!discs.includes(d)) await visit(d.abs, d.rel, depth + 1);
      return;
    }
    for (const d of here.dirs) await visit(d.abs, d.rel, depth + 1);
  }

  await visit(root, "", 0);
  return units.sort((a, b) => collator.compare(a.relPath, b.relPath));
}

/** Changes whenever a file is added, removed, renamed, resized or rewritten. */
export function unitSignature(unit: AudiobookUnit): string {
  return unit.files.map((f) => `${f.relPath}:${f.sizeBytes}:${f.mtimeMs}`).join("|");
}

/** Same files by name and size, wherever the folder lives now: a move or rename. */
export function contentKey(files: { relPath: string; sizeBytes: number }[]): string {
  return files.map((f) => `${f.relPath.split("/").pop()}:${f.sizeBytes}`).join("|");
}
