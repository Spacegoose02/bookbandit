/**
 * What the admin and family pages ask the server for. Separate from src/api/client.ts so the
 * reader app's Api stays small; same request helper and the same demo switch.
 * Server side: library/routes.ts, routes/admin-*.ts, routes/users.ts, routes/devices.ts,
 * integrations/*. Endpoint list: docs/admin-api.md.
 */
import type { ContentRating, KidSignInMethod, ProfileSignIn, Role, SignInPicture } from "@bookbandit/shared";
import { isDemo, request } from "../api/client";
import { demoAdminApi } from "./demo";

const json = (body: unknown) => JSON.stringify(body);
const enc = encodeURIComponent;

export interface Overview {
  inbox: number;
  unrated: number;
  books: number;
  people: { grownUps: number; kids: number };
  devices: number;
  pendingRequests: number;
}

export interface ScanReport {
  startedAt: number;
  finishedAt: number;
  filesSeen: number;
  unchanged: number;
  added: number;
  attached: number;
  updated: number;
  moved: number;
  removed: number;
  duplicates: { relPath: string; sameAs: string }[];
  missingBookIds: string[];
  errors: { relPath: string; error: string }[];
}

export interface ScanStatus {
  running: boolean;
  startedAt: number | null;
  progress: { done: number; total: number } | null;
  lastReport: ScanReport | null;
  lastError: string | null;
}

export interface AdminFile {
  id: string;
  relPath: string;
  format: string;
  sizeBytes: number;
}

export type RatingSource = "admin" | "folder" | "metadata" | "ai" | "keywords";

/** Barnaby's pending rating for a book (ai/review.ts on the server). */
export interface BarnabyRating {
  rating: ContentRating;
  confidence: number;
  reasons: string;
}

/** One pending metadata fix: the value is a string, a list of names, or a series. */
export type FixValue = string | string[] | { name: string; position: number | null } | null;
export interface BarnabyFix {
  id: string;
  field: "title" | "subtitle" | "authors" | "series" | "description";
  current: FixValue;
  suggested: FixValue;
  reason: string;
}

export type InboxFilter = "all" | "suggested" | "unseen";

export interface InboxPage extends PageOf<InboxItem> {
  counts: Record<InboxFilter, number>;
}

export interface ApproveOptions {
  /** An admin rating for every book. */
  rating?: ContentRating;
  /** Take Barnaby's pending rating where he has one. */
  barnabyRating?: boolean;
  /** Apply Barnaby's pending detail fixes. */
  barnabyFixes?: boolean;
}

export interface InboxItem {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  publishedYear: number | null;
  isbn13: string | null;
  coverPath: string | null;
  description: string | null;
  rating: ContentRating | null;
  ratingSource: RatingSource | null;
  files: AdminFile[];
  addedAt: number;
  possibleDuplicates: PossibleDuplicate[];
  barnaby: { rating: BarnabyRating | null; fixes: BarnabyFix[] };
}

/** A book the inbox book may be another copy or format of. Never a different volume of a series. */
export interface PossibleDuplicate {
  id: string;
  title: string;
  approved: boolean;
  /** Its number in a series, when known. */
  volume: number | null;
  isbn13: string | null;
  /** Matched by ISBN rather than by title. */
  sameIsbn: boolean;
  addedAt: number;
  files: { format: string; sizeBytes: number }[];
}

export interface AdminBook {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  description: string | null;
  publisher: string | null;
  language: string | null;
  publishedYear: number | null;
  isbn13: string | null;
  coverPath: string | null;
  rating: ContentRating | null;
  ratingSource: RatingSource | null;
  approved: boolean;
  files: AdminFile[];
  addedAt: number;
}

/** A row on "Needs a rating". */
export type UnratedBook = AdminBook & { barnaby: { rating: BarnabyRating | null } };

export interface BookPatch {
  title?: string;
  subtitle?: string | null;
  description?: string | null;
  publisher?: string | null;
  publishedYear?: number | null;
  isbn13?: string | null;
  authors?: string[];
  rating?: ContentRating | null;
}

export interface PageOf<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface UserView {
  id: string;
  displayName: string;
  role: Role;
  birthYear: number | null;
  explicitOptIn: boolean;
  avatar: string | null;
  theme: string;
  kidSignInMethod: KidSignInMethod | null;
  signIn: ProfileSignIn;
  disabled: boolean;
  identities: { id: string; provider: "tinyauth" | "local"; subject: string }[];
  parentIds: string[];
  kidIds: string[];
  createdAt: number;
}

export interface ProfileCard {
  id: string;
  displayName: string;
  avatar: string | null;
  role: Role;
}

export interface NewPerson {
  displayName: string;
  role: Role;
  birthYear?: number;
  avatar?: string | null;
  kidSignInMethod?: KidSignInMethod;
  pin?: string;
  pictures?: SignInPicture[];
  email?: string;
  username?: string;
  password?: string;
  parentIds?: string[];
}

export interface PersonPatch {
  displayName?: string;
  birthYear?: number | null;
  avatar?: string | null;
  kidSignInMethod?: KidSignInMethod;
  disabled?: boolean;
  role?: Role;
}

export type SecretInput = { pin: string } | { pictures: SignInPicture[] } | { password: string };

export interface Device {
  id: string;
  name: string;
  userId: string | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface Pairing {
  pairingId: string;
  code: string;
  expiresAt: number;
  qr: string;
}

export type AbsSettings =
  | { configured: false }
  | { configured: true; enabled: boolean; url: string; libraryIds: string[]; hasToken: boolean };
export interface AbsInput {
  enabled: boolean;
  url: string;
  token?: string;
  libraryIds: string[];
}

export type SmtpSettings =
  | { configured: false }
  | { configured: true; enabled: boolean; host: string; port: number; secure: boolean; user?: string; from: string; hasPassword: boolean };
export interface SmtpInput {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export interface MetadataSettings {
  online: boolean;
  hasHardcoverToken: boolean;
  hasGoogleApiKey: boolean;
  /** Added by ws/migrate; optional so older servers still work. */
  hasIsbndbKey?: boolean;
  fromEnv: { hardcoverToken: boolean; googleApiKey: boolean; isbndbKey?: boolean };
  saved: boolean;
}
export interface MetadataInput {
  online: boolean;
  /** omit = keep, null = clear */
  hardcoverToken?: string | null;
  googleApiKey?: string | null;
  isbndbKey?: string | null;
}

// --- family dashboard ---------------------------------------------------------

export interface KidCard {
  id: string;
  displayName: string;
  avatar: string | null;
  birthYear: number | null;
  age: number | null;
  maxRating: ContentRating;
  kidSignInMethod: KidSignInMethod | null;
  disabled: boolean;
}

export interface KidStats {
  readingNow: number;
  finished: number;
  finishedLast30Days: number;
  booksOpenedLast7Days: number;
  lastReadAt: number | null;
  lastBook: { id: string; title: string } | null;
  pendingRequests: number;
  aiQuestionsLast7Days: number;
  aiFlaggedLast7Days: number;
}

export interface KidReading {
  bookId: string;
  title: string;
  authors: string[];
  coverPath: string | null;
  rating: ContentRating | null;
  percent: number;
  finished: boolean;
  deviceName: string | null;
  updatedAt: number;
}

export interface KidRequest {
  id: string;
  title: string;
  author: string | null;
  rating: ContentRating | null;
  status: "pending" | "approved" | "declined" | "downloading" | "done" | "failed";
  note: string | null;
  createdAt: number;
}

export interface KidChat {
  conversationId: string;
  startedAt: number;
  lastAt: number;
  messages: number;
  flagged: number;
  bookId: string | null;
  bookTitle: string | null;
  preview: string;
}

export interface KidDetail {
  kid: KidCard;
  stats: KidStats;
  reading: KidReading[];
  requests: KidRequest[];
  chats: KidChat[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  moderation: string | null;
  createdAt: number;
}

/** GET /api/reading/stats (docs/sync-api.md#reading-time) */
export interface ReadingStats {
  user: { id: string; displayName: string };
  totalSeconds: number;
  streakDays: number;
  days: { date: string; readSeconds: number; listenSeconds: number }[];
  books: { id: string; title: string; coverPath: string | null; seconds: number }[];
}

export interface AdminApi {
  overview(): Promise<Overview>;
  scanStatus(): Promise<ScanStatus>;
  startScan(): Promise<ScanStatus>;

  inbox(offset?: number, filter?: InboxFilter): Promise<InboxPage>;
  approve(ids: string[], opts?: ApproveOptions): Promise<{ approved: number }>;
  reject(id: string): Promise<void>;
  unrated(offset?: number): Promise<PageOf<UnratedBook>>;
  /** Take Barnaby's pending ratings for these books, as admin ratings. */
  acceptBarnabyRatings(bookIds: string[]): Promise<{ accepted: number }>;
  dismissBarnabyRating(bookId: string): Promise<void>;
  acceptFix(id: string): Promise<void>;
  dismissFix(id: string): Promise<void>;
  /** Ask Barnaby to rate and tidy these books now (the rating helper and metadata cleanup). */
  askBarnaby(bookIds: string[]): Promise<{ rating: boolean; metadata: boolean; error?: string }>;
  setRating(id: string, rating: ContentRating | null): Promise<void>;
  editBook(id: string, patch: BookPatch): Promise<AdminBook>;
  mergeBook(id: string, intoId: string): Promise<void>;
  refreshMetadata(id: string): Promise<void>;
  coverUrl(b: { id: string; coverPath: string | null }): string | null;

  people(): Promise<{ users: UserView[]; household: ProfileCard[] }>;
  addPerson(p: NewPerson): Promise<UserView>;
  updatePerson(id: string, patch: PersonPatch): Promise<UserView>;
  setSecret(id: string, secret: SecretInput): Promise<UserView>;
  linkParent(kidId: string, parentId: string): Promise<UserView>;
  unlinkParent(kidId: string, parentId: string): Promise<UserView>;

  devices(): Promise<Device[]>;
  startPairing(name: string, userId: string | null): Promise<Pairing>;
  updateDevice(id: string, patch: { name?: string; userId?: string | null }): Promise<Device>;
  revokeDevice(id: string): Promise<Device>;

  absSettings(): Promise<AbsSettings>;
  saveAbs(input: AbsInput): Promise<AbsSettings>;
  testAbs(): Promise<{ ok: true; username: string; libraries: { id: string; name: string; mediaType: string }[] }>;
  smtpSettings(): Promise<SmtpSettings>;
  saveSmtp(input: SmtpInput): Promise<SmtpSettings>;
  testSmtp(to: string): Promise<{ ok: true }>;
  metadataSettings(): Promise<MetadataSettings>;
  saveMetadata(input: MetadataInput): Promise<MetadataSettings>;

  familyKids(): Promise<(KidCard & { stats: KidStats })[]>;
  familyKid(id: string): Promise<KidDetail>;
  familyChat(kidId: string, conversationId: string): Promise<ChatMessage[]>;
  readingStats(userId: string, days?: number): Promise<ReadingStats>;
}

export const httpAdminApi: AdminApi = {
  overview: () => request("/api/admin/overview"),
  scanStatus: () => request("/api/admin/library/scan"),
  startScan: () => request("/api/admin/library/scan", { method: "POST" }),

  inbox: (offset = 0, filter = "all") => request(`/api/admin/inbox?limit=50&offset=${offset}&filter=${filter}`),
  approve: (ids, opts = {}) => request("/api/admin/inbox/approve", { method: "POST", body: json({ ids, ...opts }) }),
  reject: async (id) => {
    await request(`/api/admin/inbox/${enc(id)}/reject`, { method: "POST", body: json({}) });
  },
  unrated: (offset = 0) => request(`/api/admin/review/unrated?limit=50&offset=${offset}`),
  acceptBarnabyRatings: (bookIds) => request("/api/admin/ai/rating/suggestions/accept", { method: "POST", body: json({ bookIds }) }),
  dismissBarnabyRating: async (bookId) => {
    await request(`/api/admin/ai/rating/suggestions/${enc(bookId)}/dismiss`, { method: "POST", body: json({}) });
  },
  acceptFix: async (id) => {
    await request(`/api/admin/ai/metadata/suggestions/${enc(id)}/accept`, { method: "POST", body: json({}) });
  },
  dismissFix: async (id) => {
    await request(`/api/admin/ai/metadata/suggestions/${enc(id)}/dismiss`, { method: "POST", body: json({}) });
  },
  async askBarnaby(bookIds) {
    // Both tools take up to 500 named books per run; one of them may be off or already busy.
    const ids = bookIds.slice(0, 500);
    const run = (path: string) =>
      request(path, { method: "POST", body: json({ bookIds: ids }) }).then(
        () => ({ ok: true, error: undefined as string | undefined }),
        (e: Error) => ({ ok: false, error: e.message }),
      );
    const [rating, metadata] = await Promise.all([run("/api/admin/ai/rating/run"), run("/api/admin/ai/metadata/run")]);
    return { rating: rating.ok, metadata: metadata.ok, error: rating.error ?? metadata.error };
  },
  setRating: async (id, rating) => {
    await request(`/api/admin/books/${enc(id)}/rating`, { method: "PUT", body: json({ rating }) });
  },
  editBook: (id, patch) => request(`/api/admin/books/${enc(id)}`, { method: "PATCH", body: json(patch) }),
  mergeBook: async (id, intoId) => {
    await request(`/api/admin/books/${enc(id)}/merge`, { method: "POST", body: json({ intoId }) });
  },
  refreshMetadata: async (id) => {
    await request(`/api/admin/books/${enc(id)}/metadata/refresh`, { method: "POST" });
  },
  coverUrl: (b) => (b.coverPath ? `/api/books/${enc(b.id)}/cover` : null),

  people: () => request("/api/users"),
  addPerson: (p) => request("/api/users", { method: "POST", body: json(p) }),
  updatePerson: (id, patch) => request(`/api/users/${enc(id)}`, { method: "PATCH", body: json(patch) }),
  setSecret: (id, secret) => request(`/api/users/${enc(id)}/secret`, { method: "PUT", body: json(secret) }),
  linkParent: (kidId, parentId) => request(`/api/users/${enc(kidId)}/parents`, { method: "POST", body: json({ parentId }) }),
  unlinkParent: (kidId, parentId) => request(`/api/users/${enc(kidId)}/parents/${enc(parentId)}`, { method: "DELETE" }),

  devices: () => request<{ devices: Device[] }>("/api/devices").then((r) => r.devices),
  startPairing: (name, userId) => request("/api/devices/pairings", { method: "POST", body: json({ name, userId }) }),
  updateDevice: (id, patch) => request(`/api/devices/${enc(id)}`, { method: "PATCH", body: json(patch) }),
  revokeDevice: (id) => request(`/api/devices/${enc(id)}`, { method: "DELETE" }),

  absSettings: () => request("/api/admin/integrations/audiobookshelf"),
  saveAbs: (input) => request("/api/admin/integrations/audiobookshelf", { method: "PUT", body: json(input) }),
  testAbs: () => request("/api/admin/integrations/audiobookshelf/test", { method: "POST" }),
  smtpSettings: () => request("/api/admin/integrations/smtp"),
  saveSmtp: (input) => request("/api/admin/integrations/smtp", { method: "PUT", body: json(input) }),
  testSmtp: (to) => request("/api/admin/integrations/smtp/test", { method: "POST", body: json({ to }) }),
  metadataSettings: () => request("/api/admin/settings/metadata"),
  saveMetadata: (input) => request("/api/admin/settings/metadata", { method: "PUT", body: json(input) }),

  familyKids: () => request<{ kids: (KidCard & { stats: KidStats })[] }>("/api/family/kids").then((r) => r.kids),
  familyKid: (id) => request(`/api/family/kids/${enc(id)}`),
  familyChat: (kidId, conversationId) =>
    request<{ messages: ChatMessage[] }>(`/api/family/kids/${enc(kidId)}/chats/${enc(conversationId)}`).then((r) => r.messages),
  readingStats: (userId, days = 7) =>
    request(`/api/reading/stats?${new URLSearchParams({ userId, days: String(days), utcOffset: String(-new Date().getTimezoneOffset()) })}`),
};

export const adminApi: AdminApi = isDemo ? demoAdminApi : httpAdminApi;
