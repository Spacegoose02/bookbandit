/**
 * Admin API for audio: the audiobook folder scan, local audiobooks, each person's
 * Audiobookshelf account and the ABS import. Demo mode answers with sample data.
 */
import { isDemo, request } from "../api/client";

export interface AudioScanReport {
  startedAt: number;
  finishedAt: number;
  foldersSeen: number;
  unchanged: number;
  added: number;
  linked: number;
  updated: number;
  moved: number;
  removed: number;
  errors: { relPath: string; error: string }[];
}

export interface AudioScanStatus {
  audiobooksDir: string;
  running: boolean;
  startedAt: number | null;
  progress: { done: number; total: number } | null;
  lastReport: AudioScanReport | null;
  lastError: string | null;
}

export interface LocalAudiobook {
  id: string;
  relPath: string;
  duration: number;
  narrator: string | null;
  trackCount: number;
  chapterCount: number;
  bookId: string;
  title: string;
  approved: boolean;
  rating: string | null;
  absItemId: string | null;
}

export interface AbsAccountRow {
  userId: string;
  displayName: string;
  role: string;
  account: {
    absUsername: string;
    writeBack: boolean;
    lastImportAt: number | null;
    lastPushAt: number | null;
    lastError: string | null;
  } | null;
}

export interface AbsImportReport {
  userId: string;
  absUsername: string;
  dryRun: boolean;
  imported: number;
  finished: number;
  keptNewer: number;
  unlinked: number;
  bookmarksImported: number;
  bookmarksSkipped: number;
  books: { bookId: string; title: string; currentTime: number; duration: number; finished: boolean }[];
}

export interface AbsImportResult {
  dryRun: boolean;
  reports: AbsImportReport[];
  errors: { userId: string; error: string }[];
}

export interface AudioAdminApi {
  scanStatus(): Promise<AudioScanStatus>;
  startScan(): Promise<AudioScanStatus>;
  audiobooks(q?: string): Promise<LocalAudiobook[]>;
  accounts(): Promise<AbsAccountRow[]>;
  saveAccount(userId: string, body: { token?: string; writeBack?: boolean }): Promise<unknown>;
  unlinkAccount(userId: string): Promise<void>;
  importAbs(body: { userIds?: string[]; dryRun: boolean }): Promise<AbsImportResult>;
}

const enc = encodeURIComponent;

export const httpAudioAdminApi: AudioAdminApi = {
  scanStatus: () => request("/api/admin/audiobooks/scan"),
  startScan: () => request("/api/admin/audiobooks/scan", { method: "POST" }),
  audiobooks: async (q) => (await request<{ items: LocalAudiobook[] }>(`/api/admin/audiobooks${q ? `?q=${enc(q)}` : ""}`)).items,
  accounts: async () => (await request<{ items: AbsAccountRow[] }>("/api/admin/audiobookshelf/accounts")).items,
  saveAccount: (userId, body) => request(`/api/admin/audiobookshelf/accounts/${enc(userId)}`, { method: "PUT", body: JSON.stringify(body) }),
  unlinkAccount: async (userId) => {
    await request<void>(`/api/admin/audiobookshelf/accounts/${enc(userId)}`, { method: "DELETE" });
  },
  importAbs: (body) => request("/api/admin/audiobookshelf/import", { method: "POST", body: JSON.stringify(body) }),
};

// ---------------------------------------------------------------- demo

const HOUR = 3600;
const demoNow = Date.now();
const demoReport: AudioScanReport = {
  startedAt: demoNow - 6 * 60_000,
  finishedAt: demoNow - 5 * 60_000,
  foldersSeen: 42,
  unchanged: 38,
  added: 2,
  linked: 2,
  updated: 0,
  moved: 0,
  removed: 0,
  errors: [],
};
let demoStatus: AudioScanStatus = {
  audiobooksDir: "/audiobooks",
  running: false,
  startedAt: demoReport.startedAt,
  progress: null,
  lastReport: demoReport,
  lastError: null,
};
const demoBooks: LocalAudiobook[] = [
  { id: "a1", relPath: "kids/Pip Harlow/Dino Readers/Book 1 - The Dinosaur Who Loved Books", duration: 1.6 * HOUR, narrator: "Priya Shah", trackCount: 1, chapterCount: 9, bookId: "b1", title: "The Dinosaur Who Loved Books", approved: true, rating: "kids", absItemId: "abs-b1" },
  { id: "a2", relPath: "kids/Juniper Vale/Barnaby and the Missing Page", duration: 2.2 * HOUR, narrator: "Barnaby", trackCount: 12, chapterCount: 12, bookId: "b3", title: "Barnaby and the Missing Page", approved: true, rating: "kids", absItemId: null },
  { id: "a3", relPath: "Ola Night/Night Owls", duration: 6.1 * HOUR, narrator: "Sam Reader", trackCount: 2, chapterCount: 14, bookId: "b-new", title: "Night Owls", approved: false, rating: "teen", absItemId: null },
];
let demoAccounts: AbsAccountRow[] = [
  { userId: "u-admin", displayName: "Alex (you)", role: "admin", account: { absUsername: "alex", writeBack: true, lastImportAt: demoNow - 2 * 86_400_000, lastPushAt: demoNow - 20 * 60_000, lastError: null } },
  { userId: "u-dad", displayName: "Dad", role: "parent", account: { absUsername: "dad", writeBack: true, lastImportAt: demoNow - 2 * 86_400_000, lastPushAt: null, lastError: null } },
  { userId: "u-emma", displayName: "Emma", role: "kid", account: null },
  { userId: "u-leo", displayName: "Leo", role: "kid", account: null },
];

export const demoAudioAdminApi: AudioAdminApi = {
  async scanStatus() {
    return demoStatus;
  },
  async startScan() {
    demoStatus = { ...demoStatus, running: true, startedAt: Date.now(), progress: { done: 7, total: 42 } };
    setTimeout(() => {
      demoStatus = { ...demoStatus, running: false, progress: null, lastReport: { ...demoReport, startedAt: Date.now() - 2000, finishedAt: Date.now(), added: 0, linked: 0, unchanged: 42 } };
    }, 1500);
    return demoStatus;
  },
  async audiobooks(q) {
    const n = q?.toLowerCase();
    return n ? demoBooks.filter((b) => `${b.title} ${b.relPath}`.toLowerCase().includes(n)) : demoBooks;
  },
  async accounts() {
    return demoAccounts;
  },
  async saveAccount(userId, body) {
    demoAccounts = demoAccounts.map((a) =>
      a.userId !== userId
        ? a
        : {
            ...a,
            account: {
              absUsername: a.account?.absUsername ?? a.displayName.toLowerCase(),
              writeBack: body.writeBack ?? a.account?.writeBack ?? true,
              lastImportAt: a.account?.lastImportAt ?? null,
              lastPushAt: a.account?.lastPushAt ?? null,
              lastError: null,
            },
          },
    );
    return {};
  },
  async unlinkAccount(userId) {
    demoAccounts = demoAccounts.map((a) => (a.userId === userId ? { ...a, account: null } : a));
  },
  async importAbs({ dryRun }) {
    const linked = demoAccounts.filter((a) => a.account);
    return {
      dryRun,
      errors: [],
      reports: linked.map((a, i) => ({
        userId: a.userId,
        absUsername: a.account!.absUsername,
        dryRun,
        imported: i === 0 ? 5 : 2,
        finished: i === 0 ? 3 : 1,
        keptNewer: i === 0 ? 1 : 0,
        unlinked: i === 0 ? 2 : 0,
        bookmarksImported: i === 0 ? 4 : 1,
        bookmarksSkipped: 0,
        books: [
          { bookId: "b1", title: "The Dinosaur Who Loved Books", currentTime: 0.7 * HOUR, duration: 1.6 * HOUR, finished: false },
          { bookId: "b15", title: "Little Fox Says Goodnight", currentTime: 0.3 * HOUR, duration: 0.3 * HOUR, finished: true },
        ].slice(0, i === 0 ? 2 : 1),
      })),
    };
  },
};

export const audioAdminApi: AudioAdminApi = isDemo ? demoAudioAdminApi : httpAudioAdminApi;
