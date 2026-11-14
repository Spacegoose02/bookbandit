/**
 * KOReader names a book by a hash of its file. By default ("binary" document matching) that's
 * a partial MD5 of 1 KB samples at growing offsets; the other option is the MD5 of the file
 * name. We keep both for every library file, so a progress update finds its book.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookFiles } from "../db/schema.js";
import { fileDigests } from "../ereader/schema.js";
import { absolutePath } from "../ereader/library.js";
import { md5hex } from "../ereader/credentials.js";

/**
 * KOReader's `util.partialMD5`: MD5 over 1024-byte reads at offsets 1024 << (2·i) for
 * i = -1..10, stopping at the end of the file. In LuaJIT, lshift(1024, -2) wraps to 0, so
 * the first sample is the start of the file.
 */
export async function partialMd5(abs: string): Promise<string> {
  const fh = await open(abs, "r");
  try {
    const hash = createHash("md5");
    const buf = Buffer.alloc(1024);
    for (let i = -1; i <= 10; i++) {
      const offset = i < 0 ? 0 : 1024 * 4 ** i;
      const { bytesRead } = await fh.read(buf, 0, 1024, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await fh.close();
  }
}

export function nameMd5(relPath: string): string {
  return md5hex(basename(relPath));
}

/** Looks up library files by KOReader document id, hashing new or changed files on a miss. */
export class DigestIndex {
  private lastRefresh = 0;
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly booksDir: string,
    /** A miss rehashes at most this often. */
    private readonly refreshEveryMs = 30_000,
  ) {}

  private lookup(document: string): string[] {
    return this.db
      .select({ fileId: fileDigests.fileId })
      .from(fileDigests)
      .where(or(eq(fileDigests.partialMd5, document), eq(fileDigests.nameMd5, document)))
      .all()
      .map((r) => r.fileId);
  }

  /** File ids whose KOReader id is `document` (no content lock here: callers filter). */
  async find(document: string): Promise<string[]> {
    const doc = document.trim().toLowerCase();
    const hit = this.lookup(doc);
    if (hit.length) return hit;
    if (Date.now() - this.lastRefresh < this.refreshEveryMs) return [];
    await this.refresh();
    return this.lookup(doc);
  }

  /** Hash files that are new or whose size or mtime changed since they were hashed. */
  refresh(): Promise<void> {
    this.running ??= this.doRefresh().finally(() => {
      this.lastRefresh = Date.now();
      this.running = null;
    });
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    const rows = this.db
      .select({ file: bookFiles, digest: fileDigests })
      .from(bookFiles)
      .leftJoin(fileDigests, eq(fileDigests.fileId, bookFiles.id))
      .all();
    for (const { file, digest } of rows) {
      const abs = absolutePath(this.booksDir, file);
      if (!abs) continue;
      const info = await stat(abs).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (digest && digest.sizeBytes === info.size && digest.mtimeMs === Math.floor(info.mtimeMs)) continue;
      let partial: string;
      try {
        partial = await partialMd5(abs);
      } catch {
        continue;
      }
      const values = { partialMd5: partial, nameMd5: nameMd5(file.relPath), sizeBytes: info.size, mtimeMs: Math.floor(info.mtimeMs) };
      this.db
        .insert(fileDigests)
        .values({ fileId: file.id, ...values })
        .onConflictDoUpdate({ target: fileDigests.fileId, set: values })
        .run();
    }
  }
}
