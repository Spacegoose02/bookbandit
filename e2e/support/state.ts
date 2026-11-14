/** What global setup created, shared with the tests through a JSON file. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BookKey } from "./library.js";

export const RUN_DIR = join(import.meta.dirname, "..", ".run");
export const STATE_FILE = join(RUN_DIR, "state.json");

export interface World {
  baseURL: string;
  aiURL: string;
  booksDir: string;
  admin: { id: string; username: string; password: string; token: string };
  dad: { id: string; username: string; password: string; token: string };
  emma: { id: string; pin: string; token: string };
  /** A shared family tablet (no one locked to it). */
  tablet: { deviceToken: string };
  books: Record<BookKey, { id: string; fileId: string; title: string; relPath: string }>;
  ereader: {
    emma: { username: string; password: string; koboToken: string };
    dad: { username: string; password: string; koboToken: string };
  };
  seriesId: string;
  categoryId: string;
}

let cached: World | undefined;
export function world(): World {
  cached ??= JSON.parse(readFileSync(STATE_FILE, "utf8")) as World;
  return cached;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const basic = (u: string, p: string) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });

/** A PUT /api/progress/:bookId body for an EPUB position. */
export const progressBody = (percent: number, chapter = 4) => ({
  locator: { kind: "epub", cfi: `epubcfi(/6/${chapter}!/4/2)`, percent },
  percent,
  updatedAt: Date.now(),
  deviceName: "e2e",
});
