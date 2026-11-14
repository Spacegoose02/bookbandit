/**
 * Disk cache for spoken clips: CONFIG_DIR/cache/narration/<sha256>.mp3 plus a .json with the word
 * timings. The key covers the server, model, voice, speed and text, so a chapter read once is
 * free the next time (and for every kid who picks the same voice). Oldest clips are dropped
 * when the folder grows past the admin's limit. Clips are plain files: deleting the folder is safe.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WordTiming } from "./tts.js";

export const CLIP_ID = /^[a-f0-9]{64}$/;

export interface ClipMeta {
  contentType: string;
  words: WordTiming[] | null;
  bytes: number;
}

export function clipKey(parts: { server: string; model: string; voice: string; speed: number; text: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.server, parts.model, parts.voice, Math.round(parts.speed * 100), parts.text]))
    .digest("hex");
}

export class ClipCache {
  private inflight = new Map<string, Promise<ClipMeta>>();
  private sinceTrim = 0;

  constructor(
    readonly dir: string,
    private maxBytes: () => number,
  ) {}

  audioPath(id: string) {
    return join(this.dir, `${id}.mp3`);
  }

  async get(id: string): Promise<ClipMeta | null> {
    try {
      const meta = JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as ClipMeta;
      const now = new Date();
      await utimes(this.audioPath(id), now, now).catch(() => undefined); // keep recently used clips
      return meta;
    } catch {
      return null;
    }
  }

  /** The cached clip, or make it once even when several readers ask at the same moment. */
  async getOrMake(id: string, make: () => Promise<{ audio: Buffer; contentType: string; words: WordTiming[] | null }>): Promise<{ meta: ClipMeta; cached: boolean }> {
    const hit = await this.get(id);
    if (hit) return { meta: hit, cached: true };
    let p = this.inflight.get(id);
    if (!p) {
      p = (async () => {
        const made = await make();
        await mkdir(this.dir, { recursive: true });
        const meta: ClipMeta = { contentType: made.contentType, words: made.words, bytes: made.audio.length };
        await writeFile(this.audioPath(id), made.audio);
        await writeFile(join(this.dir, `${id}.json`), JSON.stringify(meta));
        this.sinceTrim += made.audio.length;
        if (this.sinceTrim > 5 * 1024 * 1024) {
          this.sinceTrim = 0;
          void this.trim().catch(() => undefined);
        }
        return meta;
      })().finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return { meta: await p, cached: false };
  }

  /** Drop the least recently used clips until the folder fits. */
  async trim(): Promise<{ removed: number; bytes: number }> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const clips = [];
    for (const n of names) {
      if (!n.endsWith(".mp3")) continue;
      const s = await stat(join(this.dir, n)).catch(() => null);
      if (s) clips.push({ id: n.slice(0, -4), size: s.size, at: s.mtimeMs });
    }
    let total = clips.reduce((a, c) => a + c.size, 0);
    let removed = 0;
    for (const c of clips.sort((a, b) => a.at - b.at)) {
      if (total <= this.maxBytes()) break;
      await rm(this.audioPath(c.id), { force: true });
      await rm(join(this.dir, `${c.id}.json`), { force: true });
      total -= c.size;
      removed++;
    }
    return { removed, bytes: total };
  }

  async usage(): Promise<{ clips: number; bytes: number }> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    let bytes = 0;
    let clips = 0;
    for (const n of names) {
      if (!n.endsWith(".mp3")) continue;
      const s = await stat(join(this.dir, n)).catch(() => null);
      if (s) {
        clips++;
        bytes += s.size;
      }
    }
    return { clips, bytes };
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
