/**
 * Chapters from an M4B/M4A file's Nero `chpl` atom (moov/udta/chpl), which ffmpeg, mp4v2 and
 * most audiobook tools write. Reads only atom headers and the moov box, so a 1 GB file costs a
 * few small reads. music-metadata's QuickTime chapter-track reader is the fallback (it only
 * works when moov comes before mdat).
 */
import { open, type FileHandle } from "node:fs/promises";

export interface RawChapter {
  /** Seconds. */
  start: number;
  title: string;
}

const MAX_MOOV_BYTES = 64 * 1024 * 1024;

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** Children of a box: [type, start of payload, end]. Handles 64-bit and to-end sizes. */
function* boxes(buf: Buffer, from: number, to: number): Generator<[string, number, number]> {
  let off = from;
  while (off + 8 <= to) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > to) return;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) size = to - off;
    if (size < header || off + size > to) return;
    yield [type, off + header, off + size];
    off += size;
  }
}

/** Parses a chpl payload. Exported for tests. */
export function parseChpl(p: Buffer): RawChapter[] {
  if (p.length < 5) return [];
  const version = p[0]!;
  let off = 4;
  if (version === 1) off += 4; // reserved
  const count = p[off++] ?? 0;
  const out: RawChapter[] = [];
  for (let i = 0; i < count && off + 9 <= p.length; i++) {
    const start = Number(p.readBigUInt64BE(off)) / 10_000_000; // 100 ns units
    const len = p[off + 8]!;
    off += 9;
    const title = p.toString("utf8", off, Math.min(off + len, p.length)).trim();
    off += len;
    out.push({ start, title });
  }
  return out;
}

export async function readMp4Chapters(path: string): Promise<RawChapter[]> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = 0;
    while (pos + 8 <= size) {
      const head = await readAt(fh, pos, 16);
      if (head.length < 8) return [];
      let boxSize = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < 8) return [];
      if (type === "moov") {
        if (boxSize > MAX_MOOV_BYTES) return [];
        const moov = await readAt(fh, pos, boxSize);
        const hdr = moov.readUInt32BE(0) === 1 ? 16 : 8;
        for (const [t, s, e] of boxes(moov, hdr, moov.length)) {
          if (t !== "udta") continue;
          for (const [t2, s2, e2] of boxes(moov, s, e)) {
            if (t2 === "chpl") return parseChpl(moov.subarray(s2, e2));
          }
        }
        return [];
      }
      pos += boxSize;
    }
    return [];
  } finally {
    await fh.close();
  }
}
