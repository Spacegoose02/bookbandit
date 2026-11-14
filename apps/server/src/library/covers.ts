/**
 * Cover images live in CONFIG_DIR/covers/<bookId>.<ext>; books.cover_path stores the path
 * relative to CONFIG_DIR (e.g. "covers/1b2c….jpg"). Covers are a cache: a rescan rebuilds them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cover } from "../metadata/types.js";
import { USER_AGENT, type FetchLike } from "../metadata/providers/http.js";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_COVER_BYTES = 10 * 1024 * 1024;

export async function saveCover(configDir: string, bookId: string, cover: Cover): Promise<string | undefined> {
  const ext = EXT[cover.mime.toLowerCase()];
  if (!ext || cover.data.length === 0 || cover.data.length > MAX_COVER_BYTES) return undefined;
  const dir = join(configDir, "covers");
  await mkdir(dir, { recursive: true });
  const rel = `covers/${bookId}.${ext}`;
  await writeFile(join(configDir, rel), cover.data);
  return rel;
}

export async function downloadCover(fetchFn: FetchLike, url: string): Promise<Cover | undefined> {
  const res = await fetchFn(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return undefined;
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!EXT[mime]) return undefined;
  const data = Buffer.from(await res.arrayBuffer());
  // Open Library returns a 1x1 placeholder (~43 bytes) for missing covers.
  if (data.length < 1024 || data.length > MAX_COVER_BYTES) return undefined;
  return { data, mime };
}
