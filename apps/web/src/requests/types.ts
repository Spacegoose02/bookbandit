import type { ContentRating, Role } from "@bookbandit/shared";

export type RequestStatus = "pending" | "approved" | "declined" | "downloading" | "done" | "failed";
export type Via = "auto" | "shelfmark" | "sabnzbd" | "direct";

/** GET /api/requests/search */
export interface Candidate {
  ref: string;
  title: string;
  author: string | null;
  publishedYear: number | null;
  isbn13: string | null;
  coverUrl: string | null;
  rating: ContentRating | null;
  ratingReason: string | null;
  inLibrary: { id: string } | null;
}

export interface SearchResult {
  items: Candidate[];
  /** Kids: results hidden because they're above (or not known to be within) the kid's limit. */
  hiddenForAge: number;
}

/** One request as the server shows it to the current reader. */
export interface BookRequest {
  id: string;
  title: string;
  author: string | null;
  isbn13: string | null;
  coverUrl: string | null;
  publishedYear: number | null;
  rating: ContentRating | null;
  ratingReason: string | null;
  status: RequestStatus;
  note: string | null;
  requestedBy: { id: string; displayName: string; role: Role; avatar: string | null } | null;
  decidedBy: { id: string; displayName: string } | null;
  createdAt: number;
  updatedAt: number | null;
  decidedAt: number | null;
  /** Set only when this reader may open the finished book. */
  book: { id: string; title: string; coverPath: string | null } | null;
  waitingForReview: boolean;
  download: { jobId: string | null; status: JobStatus; progress: number | null; error: string | null } | null;
  canApprove: boolean;
  canDecline: boolean;
  canCancel: boolean;
  canDownload: boolean;
}

export interface NewRequest {
  title: string;
  author?: string | null;
  isbn13?: string | null;
  coverUrl?: string | null;
  publishedYear?: number | null;
  note?: string | null;
}

export type CreateResult =
  | { kind: "created"; request: BookRequest; duplicate: boolean }
  | { kind: "owned"; book: { id: string; title: string } };

export interface RequestSummary {
  open: number;
  toApprove: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  type: string;
  label: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  progress: number | null;
  lastError: string | null;
  result: unknown;
  runAfter: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number | null;
}

export interface JobDetail extends Job {
  payload: unknown;
  logs: { at: number; level: "info" | "warn" | "error"; message: string }[];
}

export interface JobList {
  items: Job[];
  total: number;
  counts: Record<JobStatus, number>;
  types: string[];
}

interface ClientPublic {
  enabled: boolean;
  url: string;
  hasApiKey: boolean;
}

export interface DownloadSettings {
  autoDownload: boolean;
  order: ("shelfmark" | "sabnzbd")[];
  shelfmark: (ClientPublic & { provider?: string }) | null;
  sabnzbd: (ClientPublic & { category: string; pathMap: { from: string; to: string } | null }) | null;
  newznab: (ClientPublic & { categories: string }) | null;
  direct: { enabled: boolean; maxMb: number };
  uploads: { allowAdults: boolean; maxMb: number };
  available: ("shelfmark" | "sabnzbd")[];
}

/** PUT body: any subset; omit apiKey to keep the stored one; null removes a client. */
export interface DownloadSettingsInput {
  autoDownload?: boolean;
  order?: ("shelfmark" | "sabnzbd")[];
  shelfmark?: { enabled?: boolean; url: string; apiKey?: string; provider?: string } | null;
  sabnzbd?: { enabled?: boolean; url: string; apiKey?: string; category?: string; pathMap?: { from: string; to: string } | null } | null;
  newznab?: { enabled?: boolean; url: string; apiKey?: string; categories?: string } | null;
  direct?: { enabled?: boolean; maxMb?: number };
  uploads?: { allowAdults?: boolean; maxMb?: number };
}

export interface UploadResult {
  files: string[];
  scanJobId: string | null;
}
