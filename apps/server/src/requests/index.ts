/**
 * Requests, downloads and uploads (ws/requests). Registered from app.ts after jobsPlugin.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { loadOrCreateKey, secretBox, type SecretBox } from "../integrations/secrets.js";
import type { LookupOptions } from "../metadata/lookup.js";
import type { FetchLike } from "../metadata/providers/http.js";
import { downloadRoutes } from "../downloads/routes.js";
import { FETCH_JOB, registerDownloadJobs, type FetchPayload } from "../downloads/jobs.js";
import { incomingRel } from "../downloads/incoming.js";
import { availableDownloaders, getDownloadSettings } from "../downloads/settings.js";
import { requestRoutes } from "./routes.js";
import { requestDownloadHooks, setRequest, type RequestRow } from "./service.js";

export interface RequestsOptions {
  db: Db;
  configDir: string;
  booksDir: string;
  lookup: LookupOptions | false;
  /** Tests: fixed key instead of CONFIG_DIR/secret.key (same key file as integrations). */
  secretKey?: Buffer;
  fetchImpl?: FetchLike;
  pollMs?: { shelfmark: number; sabnzbd: number };
}

export async function requestsPlugin(app: FastifyInstance, opts: RequestsOptions) {
  if (!app.hasDecorator("jobs")) throw new Error("requestsPlugin needs jobsPlugin registered first");
  const runner = app.jobs;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const box = lazyBox(() => opts.secretKey ?? loadOrCreateKey(opts.configDir));

  registerDownloadJobs(runner, {
    db: opts.db,
    box,
    booksDir: opts.booksDir,
    fetchImpl,
    hooks: requestDownloadHooks(opts.db),
    pollMs: opts.pollMs,
  });

  function startDownload(row: RequestRow, o: { via: FetchPayload["via"]; url?: string; auto: boolean }): string | null {
    const s = getDownloadSettings(opts.db, box);
    if (o.auto && !s.autoDownload) return null;
    if (o.via === "auto" && !availableDownloaders(s).length) return null;
    const payload: FetchPayload = {
      via: o.via,
      url: o.url,
      requestId: row.id,
      rel: incomingRel("requests", row.id),
      title: row.title,
      author: row.author,
      isbn13: row.isbn13,
    };
    const jobId = runner.enqueue(FETCH_JOB, payload, { label: `Request: ${row.title}` });
    setRequest(opts.db, row.id, { status: "downloading", jobId });
    return jobId;
  }

  await app.register(requestRoutes, { db: opts.db, fetchImpl, lookup: opts.lookup, startDownload });
  await app.register(downloadRoutes, { db: opts.db, box, booksDir: opts.booksDir, fetchImpl, runner });
}

/** The key file is only created once a secret is actually stored or read. */
function lazyBox(key: () => Buffer): SecretBox {
  let box: SecretBox | null = null;
  const get = () => (box ??= secretBox(key()));
  return { seal: (p) => get().seal(p), open: (s) => get().open(s) };
}
