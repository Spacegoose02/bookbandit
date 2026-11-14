/**
 * DRM detection, so we never serve a DRM-protected file (CLAUDE.md rule 5). We don't remove
 * DRM, we only refuse. Checks are cheap: a header read for MOBI/AZW3, the zip index for EPUB.
 */
import { open } from "node:fs/promises";
import type { BookFormat } from "./formats.js";
import { openZip } from "../metadata/zip.js";

/** Font obfuscation also lives in encryption.xml and is not DRM. */
const FONT_OBFUSCATION = ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"];

export async function isDrmProtected(absPath: string, format: BookFormat): Promise<boolean> {
  try {
    if (format === "mobi" || format === "azw3") return await mobiEncrypted(absPath);
    if (format === "epub" || format === "kepub") return await epubEncrypted(absPath);
  } catch {
    // Unreadable header: let the reader fail on it rather than guessing.
  }
  return false;
}

async function mobiEncrypted(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(86);
    await fh.read(head, 0, 86, 0);
    // PalmDB: record list starts at 78; first record's data offset is 4 bytes there.
    const record0 = head.readUInt32BE(78);
    const rec = Buffer.alloc(16);
    const { bytesRead } = await fh.read(rec, 0, 16, record0);
    if (bytesRead < 14) return false;
    // PalmDOC header: encryption type at offset 12 (0 = none, 1 = old Mobipocket, 2 = Mobipocket/Kindle DRM).
    return rec.readUInt16BE(12) !== 0;
  } finally {
    await fh.close();
  }
}

async function epubEncrypted(path: string): Promise<boolean> {
  const zip = await openZip(path);
  try {
    const names = zip.names.map((n) => n.toLowerCase());
    if (names.includes("meta-inf/rights.xml")) return true; // Adobe ADEPT
    if (!names.includes("meta-inf/encryption.xml")) return false;
    const enc = (await zip.read("META-INF/encryption.xml", 2 * 1024 * 1024)).toString("utf8");
    // Each encrypted resource names its method; anything but font obfuscation means DRM.
    const methods = [...enc.matchAll(/EncryptionMethod[^>]*Algorithm\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    return methods.some((a) => !FONT_OBFUSCATION.includes(a));
  } finally {
    zip.close();
  }
}
