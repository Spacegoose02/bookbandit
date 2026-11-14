/**
 * Requests, downloads and uploads API (server: apps/server/src/requests and downloads).
 * Kept apart from api/client.ts so this workstream owns its own calls; uses the same demo switch.
 */
import { ApiError, isDemo } from "../api/client";
import { demoRequestsApi } from "./demo";
import type {
  BookRequest,
  CreateResult,
  DownloadSettings,
  DownloadSettingsInput,
  Job,
  JobDetail,
  JobList,
  JobStatus,
  NewRequest,
  RequestStatus,
  RequestSummary,
  SearchResult,
  UploadResult,
  Via,
} from "./types";

export interface RequestsApi {
  search(q: string): Promise<SearchResult>;
  list(scope: "mine" | "approvals" | "all", status?: RequestStatus[]): Promise<{ items: BookRequest[]; total: number }>;
  summary(): Promise<RequestSummary>;
  create(r: NewRequest): Promise<CreateResult>;
  approve(id: string, note?: string): Promise<BookRequest>;
  decline(id: string, note?: string): Promise<BookRequest>;
  withdraw(id: string): Promise<void>;
  // Admin
  startDownload(id: string, via?: Via, url?: string): Promise<BookRequest>;
  jobs(q?: { status?: JobStatus; type?: string }): Promise<JobList>;
  job(id: string): Promise<JobDetail>;
  retryJob(id: string): Promise<Job>;
  cancelJob(id: string): Promise<Job>;
  settings(): Promise<DownloadSettings>;
  saveSettings(s: DownloadSettingsInput): Promise<DownloadSettings>;
  testClient(client: "shelfmark" | "sabnzbd" | "newznab"): Promise<{ ok: boolean; message: string }>;
  directDownload(url: string, title?: string, via?: "direct" | "sabnzbd"): Promise<Job>;
  uploadAllowed(): Promise<{ allowed: boolean; maxMb: number }>;
  upload(file: File, onProgress?: (fraction: number) => void): Promise<UploadResult>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const httpRequestsApi: RequestsApi = {
  search: (q) => request(`/api/requests/search?${new URLSearchParams({ q })}`),
  list: (scope, status) => {
    const p = new URLSearchParams({ scope, limit: "100" });
    if (status?.length) p.set("status", status.join(","));
    return request(`/api/requests?${p}`);
  },
  summary: () => request("/api/requests/summary"),
  create: async (r) => {
    const res = await fetch("/api/requests", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(r),
    });
    const body = (await res.json().catch(() => ({}))) as {
      request?: BookRequest;
      duplicate?: boolean;
      book?: { id: string; title: string };
      message?: string;
    };
    if (res.status === 409 && body.book) return { kind: "owned", book: body.book };
    if (!res.ok || !body.request) throw new ApiError(res.status, body.message ?? `HTTP ${res.status}`);
    return { kind: "created", request: body.request, duplicate: !!body.duplicate };
  },
  approve: (id, note) => post(`/api/requests/${enc(id)}/approve`, note ? { note } : {}),
  decline: (id, note) => post(`/api/requests/${enc(id)}/decline`, note ? { note } : {}),
  withdraw: (id) => request(`/api/requests/${enc(id)}`, { method: "DELETE" }),
  startDownload: (id, via = "auto", url) => post(`/api/admin/requests/${enc(id)}/download`, { via, ...(url ? { url } : {}) }),
  jobs: (q = {}) => {
    const p = new URLSearchParams({ limit: "100" });
    if (q.status) p.set("status", q.status);
    if (q.type) p.set("type", q.type);
    return request(`/api/admin/jobs?${p}`);
  },
  job: (id) => request(`/api/admin/jobs/${enc(id)}`),
  retryJob: (id) => post(`/api/admin/jobs/${enc(id)}/retry`),
  cancelJob: (id) => post(`/api/admin/jobs/${enc(id)}/cancel`),
  settings: () => request("/api/admin/downloads/settings"),
  saveSettings: (s) => request("/api/admin/downloads/settings", { method: "PUT", body: JSON.stringify(s) }),
  testClient: (client) => post("/api/admin/downloads/test", { client }),
  directDownload: (url, title, via = "direct") => post("/api/admin/downloads", { url, via, ...(title ? { title } : {}) }),
  uploadAllowed: () => request("/api/uploads/allowed"),
  upload: (file, onProgress) =>
    // XHR rather than fetch: it reports upload progress.
    new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/uploads?${new URLSearchParams({ filename: file.name })}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let body: { message?: string } & Partial<UploadResult> = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult);
        else reject(new ApiError(xhr.status, body.message ?? `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new ApiError(0, "The upload was interrupted"));
      xhr.send(file);
    }),
};

export const requestsApi: RequestsApi = isDemo ? demoRequestsApi : httpRequestsApi;
