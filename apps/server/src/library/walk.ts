import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { formatForPath, type BookFormat } from "./formats.js";

export interface DiskFile {
  /** Relative to the books root, always with forward slashes. */
  relPath: string;
  absPath: string;
  format: BookFormat;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Every book file under `root`. Hidden files and folders (".rejected", ".stfolder", "._x.epub")
 * are skipped, as are symlinks, so a link loop can't hang a scan.
 */
export async function walkBooks(root: string): Promise<DiskFile[]> {
  const out: DiskFile[] = [];
  async function visit(dir: string, rel: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip, don't fail the scan
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "@eaDir" || e.name === "#recycle") continue;
      const abs = join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await visit(abs, relPath);
      } else if (e.isFile()) {
        const format = formatForPath(e.name);
        if (!format) continue;
        try {
          const s = await stat(abs);
          out.push({ relPath, absPath: abs, format, sizeBytes: s.size, mtimeMs: Math.floor(s.mtimeMs) });
        } catch {
          // vanished mid-scan
        }
      }
    }
  }
  await visit(root, "");
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
