/**
 * Downloader and upload settings, stored under one key in the `settings` table.
 * API keys are sealed with the integrations SecretBox and never sent back (only `hasApiKey`).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { SecretBox } from "../integrations/secrets.js";

export const DOWNLOADS_KEY = "downloads";
export const DOWNLOADERS = ["shelfmark", "sabnzbd"] as const;
export type Downloader = (typeof DOWNLOADERS)[number];

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be http(s)")
  .transform((u) => u.replace(/\/+$/, ""));

const MB = 1024 * 1024;

/** Shelfmark (https://github.com/calibrain/shelfmark) with SHELFMARK_API_KEY set. */
const ShelfmarkInput = z.object({
  enabled: z.boolean().default(true),
  url: httpUrl,
  /** Omit to keep the stored key. */
  apiKey: z.string().min(1).optional(),
  /** Metadata provider Shelfmark searches with; empty = Shelfmark's default. */
  provider: z.string().max(50).optional(),
});

/** Points a path inside the sabnzbd container at the same folder inside ours. */
const PathMap = z.object({ from: z.string().min(1), to: z.string().min(1) });

const SabnzbdInput = z.object({
  enabled: z.boolean().default(true),
  url: httpUrl,
  apiKey: z.string().min(1).optional(),
  category: z.string().max(100).default("books"),
  /** sabnzbd's completed folder as Bookbandit sees it, when the containers mount it differently. */
  pathMap: PathMap.nullable().default(null),
});

/** A Newznab indexer (NZBGeek, Prowlarr's per-indexer feed …) that finds NZBs for sabnzbd. */
const NewznabInput = z.object({
  enabled: z.boolean().default(true),
  url: httpUrl,
  apiKey: z.string().min(1).optional(),
  /** 7020 = Books > Ebook. */
  categories: z.string().regex(/^[0-9,]+$/).default("7020"),
});

export const DownloadSettingsInput = z.object({
  /** Start a download as soon as a request is approved. */
  autoDownload: z.boolean().optional(),
  /** Which downloaders to try, in order. */
  order: z.array(z.enum(DOWNLOADERS)).max(DOWNLOADERS.length).optional(),
  /** null removes that downloader's settings. */
  shelfmark: ShelfmarkInput.nullable().optional(),
  sabnzbd: SabnzbdInput.nullable().optional(),
  newznab: NewznabInput.nullable().optional(),
  direct: z.object({ enabled: z.boolean(), maxMb: z.number().int().min(1).max(10_000) }).partial().optional(),
  uploads: z.object({ allowAdults: z.boolean(), maxMb: z.number().int().min(1).max(10_000) }).partial().optional(),
});
export type DownloadSettingsInput = z.infer<typeof DownloadSettingsInput>;

export interface ShelfmarkSettings {
  enabled: boolean;
  url: string;
  apiKey: string;
  provider?: string;
}
export interface SabnzbdSettings {
  enabled: boolean;
  url: string;
  apiKey: string;
  category: string;
  pathMap: { from: string; to: string } | null;
}
export interface NewznabSettings {
  enabled: boolean;
  url: string;
  apiKey: string;
  categories: string;
}

export interface DownloadSettings {
  autoDownload: boolean;
  order: Downloader[];
  shelfmark: ShelfmarkSettings | null;
  sabnzbd: SabnzbdSettings | null;
  newznab: NewznabSettings | null;
  direct: { enabled: boolean; maxBytes: number };
  uploads: { allowAdults: boolean; maxBytes: number };
}

export const DEFAULT_SETTINGS: DownloadSettings = {
  autoDownload: true,
  order: ["shelfmark", "sabnzbd"],
  shelfmark: null,
  sabnzbd: null,
  newznab: null,
  direct: { enabled: true, maxBytes: 500 * MB },
  uploads: { allowAdults: false, maxBytes: 500 * MB },
};

/** Stored shape: same as DownloadSettings with sealed apiKeys. */
type Stored = DownloadSettings;

export function getDownloadSettings(db: Db, box: SecretBox): DownloadSettings {
  const row = db.select().from(settings).where(eq(settings.key, DOWNLOADS_KEY)).get();
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...(row.value as Partial<Stored>) };
  const open = <T extends { apiKey: string } | null>(c: T): T => (c ? { ...c, apiKey: c.apiKey ? box.open(c.apiKey) : "" } : c);
  return { ...s, shelfmark: open(s.shelfmark), sabnzbd: open(s.sabnzbd), newznab: open(s.newznab) };
}

/** Readers that never decrypt (uploads limits, for example) can skip the box. */
export function getUploadSettings(db: Db): DownloadSettings["uploads"] {
  const row = db.select().from(settings).where(eq(settings.key, DOWNLOADS_KEY)).get();
  return { ...DEFAULT_SETTINGS.uploads, ...((row?.value as Partial<Stored> | undefined)?.uploads ?? {}) };
}

export function saveDownloadSettings(db: Db, box: SecretBox, input: DownloadSettingsInput): DownloadSettings {
  const cur = getDownloadSettings(db, box);
  const next: DownloadSettings = { ...cur };
  if (input.autoDownload !== undefined) next.autoDownload = input.autoDownload;
  if (input.order) next.order = [...new Set(input.order)];
  const withKey = <I extends { apiKey?: string }, C extends { apiKey: string } | null>(name: string, i: I, c: C) => {
    const apiKey = i.apiKey ?? c?.apiKey;
    if (!apiKey) throw Object.assign(new Error(`${name}: apiKey is required`), { statusCode: 400 });
    return { ...i, apiKey };
  };
  if (input.shelfmark !== undefined) next.shelfmark = input.shelfmark && withKey("shelfmark", input.shelfmark, cur.shelfmark);
  if (input.sabnzbd !== undefined) next.sabnzbd = input.sabnzbd && withKey("sabnzbd", input.sabnzbd, cur.sabnzbd);
  if (input.newznab !== undefined) next.newznab = input.newznab && withKey("newznab", input.newznab, cur.newznab);
  if (input.direct) {
    next.direct = {
      enabled: input.direct.enabled ?? cur.direct.enabled,
      maxBytes: input.direct.maxMb ? input.direct.maxMb * MB : cur.direct.maxBytes,
    };
  }
  if (input.uploads) {
    next.uploads = {
      allowAdults: input.uploads.allowAdults ?? cur.uploads.allowAdults,
      maxBytes: input.uploads.maxMb ? input.uploads.maxMb * MB : cur.uploads.maxBytes,
    };
  }
  const seal = <T extends { apiKey: string } | null>(c: T): T => (c ? { ...c, apiKey: box.seal(c.apiKey) } : c);
  const stored: Stored = { ...next, shelfmark: seal(next.shelfmark), sabnzbd: seal(next.sabnzbd), newznab: seal(next.newznab) };
  const now = Date.now();
  db.insert(settings)
    .values({ key: DOWNLOADS_KEY, value: stored, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: now } })
    .run();
  return next;
}

/** What the admin UI sees: no keys, just whether one is stored. */
export function publicDownloadSettings(s: DownloadSettings) {
  const hide = <T extends { apiKey: string } | null>(c: T) => {
    if (!c) return null;
    const { apiKey, ...rest } = c;
    return { ...rest, hasApiKey: !!apiKey };
  };
  return {
    autoDownload: s.autoDownload,
    order: s.order,
    shelfmark: hide(s.shelfmark),
    sabnzbd: hide(s.sabnzbd),
    newznab: hide(s.newznab),
    direct: { enabled: s.direct.enabled, maxMb: Math.round(s.direct.maxBytes / MB) },
    uploads: { allowAdults: s.uploads.allowAdults, maxMb: Math.round(s.uploads.maxBytes / MB) },
    /** Downloaders a request can use right now, in order. */
    available: availableDownloaders(s),
  };
}

export function availableDownloaders(s: DownloadSettings): Downloader[] {
  return s.order.filter((d) => {
    if (d === "shelfmark") return !!s.shelfmark?.enabled;
    // sabnzbd needs an indexer to find NZBs for a request.
    return !!s.sabnzbd?.enabled && !!s.newznab?.enabled;
  });
}
