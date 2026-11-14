/**
 * Offline word help: normalise the tapped word, find its base form, look it up in the family's
 * own list, the admin's dictionary file, then the built-in kid words. No network needed.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { KID_WORDS, type DictEntry } from "./kid-words.js";

/** Lowercase letters with inner apostrophes/hyphens; null for things that aren't words. */
export function normalizeWord(raw: string): string | null {
  const w = raw
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  if (!w || w.length > 40 || !/^\p{L}[\p{L}'-]*$/u.test(w)) return null;
  return w.replace(/'s$/, "");
}

/** The word plus likely base forms: "scampered" → scamper, "ponies" → pony, "giggling" → giggle. */
export function baseForms(word: string): string[] {
  const out = [word];
  const add = (w: string) => w.length >= 2 && !out.includes(w) && out.push(w);
  if (word.endsWith("ies")) add(word.slice(0, -3) + "y");
  if (word.endsWith("es")) add(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) add(word.slice(0, -1));
  if (word.endsWith("ied")) add(word.slice(0, -3) + "y");
  if (word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    add(stem);
    add(stem + "e");
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    add(stem);
    add(stem + "e");
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (word.endsWith("ly")) add(word.slice(0, -2));
  if (word.endsWith("ily")) add(word.slice(0, -3) + "y");
  if (word.endsWith("er")) add(word.slice(0, -2));
  if (word.endsWith("est")) add(word.slice(0, -3));
  return out;
}

/** A rough split into spoken chunks for "say it slowly": "adventure" → ["ad", "ven", "ture"]. */
export function syllables(word: string): string[] {
  const w = word.toLowerCase();
  if (w.length <= 3) return [w];
  const parts = w.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]*$|[^aeiouy](?=[^aeiouy]))?/g);
  if (!parts || parts.join("") !== w) return [w];
  // A lone silent "e" at the end joins the syllable before it ("ti-me" → "time").
  if (parts.length > 1 && /^[^aeiouy]*e$/.test(parts.at(-1)!) && !/le$/.test(w)) {
    const last = parts.pop()!;
    parts[parts.length - 1] += last;
  }
  return parts;
}

export type DictionaryFile = Map<string, DictEntry>;

let fileCache: { key: string; dict: DictionaryFile } | null = null;

/** CONFIG_DIR/dictionary.json: {"word": "meaning"} or {"word": {"meaning": "...", "example": "..."}}. */
export async function loadDictionaryFile(configDir: string): Promise<DictionaryFile | null> {
  const path = join(configDir, "dictionary.json");
  const s = await stat(path).catch(() => null);
  if (!s) return null;
  const key = `${path}:${s.mtimeMs}:${s.size}`;
  if (fileCache?.key === key) return fileCache.dict;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, string | { meaning?: string; definition?: string; example?: string }>;
    const dict: DictionaryFile = new Map();
    for (const [w, v] of Object.entries(raw)) {
      const meaning = typeof v === "string" ? v : (v?.meaning ?? v?.definition);
      if (typeof meaning === "string" && meaning.trim()) dict.set(w.toLowerCase(), { meaning: meaning.trim(), example: typeof v === "object" ? v.example : undefined });
    }
    fileCache = { key, dict };
    return dict;
  } catch {
    return null;
  }
}

export function lookupOffline(word: string, extra: DictionaryFile | null): { headword: string; entry: DictEntry } | null {
  for (const form of baseForms(word)) {
    const hit = extra?.get(form) ?? KID_WORDS.get(form);
    if (hit) return { headword: form, entry: hit };
  }
  return null;
}
