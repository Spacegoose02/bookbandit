/**
 * Admin downloader settings, connection tests and direct downloads (all requireAdmin),
 * plus browser uploads (admins, and adults when an admin allows it).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import type { SecretBox } from "../integrations/secrets.js";
import type { FetchLike } from "../metadata/providers/http.js";
import type { JobRunner } from "../jobs/runner.js";
import { jobView } from "../jobs/routes.js";
import { parse } from "../requests/validate.js";
import { NewznabClient, SabnzbdClient, ServiceError, ShelfmarkClient } from "./clients.js";
import { incomingRel, isBookFile, NotABookError, placeDownload, safeFilename, TooLargeError, writeTemp } from "./incoming.js";
import { FETCH_JOB, redact, SCAN_JOB, type FetchPayload } from "./jobs.js";
import {
  DownloadSettingsInput,
  getDownloadSettings,
  getUploadSettings,
  publicDownloadSettings,
  saveDownloadSettings,
} from "./settings.js";

const TestBody = z.object({ client: z.enum(["shelfmark", "sabnzbd", "newznab"]) });
const DirectBody = z.object({
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "must be http(s)"),
  /** direct: fetch the URL. sabnzbd: it's an NZB, send it to sabnzbd. */
  via: z.enum(["direct", "sabnzbd"]).default("direct"),
  title: z.string().trim().max(300).optional(),
});
const UploadQuery = z.object({ filename: z.string().trim().min(1).max(255) });

export interface DownloadRouteOptions {
  db: Db;
  box: SecretBox;
  booksDir: string;
  fetchImpl: FetchLike;
  runner: JobRunner;
}

export async function downloadRoutes(app: FastifyInstance, opts: DownloadRouteOptions) {
  const { db, box, runner } = opts;

  app.get("/api/admin/downloads/settings", async (req) => {
    requireAdmin(req);
    return publicDownloadSettings(getDownloadSettings(db, box));
  });

  app.put("/api/admin/downloads/settings", async (req) => {
    requireAdmin(req);
    const input = parse(DownloadSettingsInput, req.body);
    return publicDownloadSettings(saveDownloadSettings(db, box, input));
  });

  app.post("/api/admin/downloads/test", async (req) => {
    requireAdmin(req);
    const { client } = parse(TestBody, req.body);
    const s = getDownloadSettings(db, box);
    try {
      if (client === "shelfmark") {
        if (!s.shelfmark) throw httpError(409, "Shelfmark is not set up");
        await new ShelfmarkClient(s.shelfmark, opts.fetchImpl).test();
        return { ok: true, message: "Shelfmark answered and accepted the API key." };
      }
      if (client === "sabnzbd") {
        if (!s.sabnzbd) throw httpError(409, "sabnzbd is not set up");
        const v = await new SabnzbdClient(s.sabnzbd, opts.fetchImpl).test();
        return { ok: true, message: `sabnzbd ${v} answered and accepted the API key.` };
      }
      if (!s.newznab) throw httpError(409, "No Newznab indexer is set up");
      const r = await new NewznabClient(s.newznab, opts.fetchImpl).search("tolkien");
      return { ok: true, message: `The indexer answered (${r.length} results for a test search).` };
    } catch (err) {
      if (err instanceof ServiceError) return { ok: false, message: err.message };
      throw err;
    }
  });

  /** Download a file from a URL (or send an NZB URL to sabnzbd) into the inbox. */
  app.post("/api/admin/downloads", async (req, reply) => {
    requireAdmin(req);
    const body = parse(DirectBody, req.body);
    const s = getDownloadSettings(db, box);
    if (body.via === "direct" && !s.direct.enabled) throw httpError(409, "Direct downloads are turned off");
    if (body.via === "sabnzbd" && !s.sabnzbd?.enabled) throw httpError(409, "sabnzbd is not set up");
    const id = crypto.randomUUID();
    const payload: FetchPayload = {
      via: body.via,
      url: body.url,
      title: body.title,
      rel: incomingRel(body.via === "direct" ? "direct" : "sabnzbd", id),
    };
    const jobId = runner.enqueue(FETCH_JOB, payload, { label: `Download: ${body.title || redact(body.url)}` });
    reply.code(202);
    return jobView(runner.get(jobId)!);
  });

  app.get("/api/uploads/allowed", async (req) => {
    const reader = requireReader(req);
    const u = getUploadSettings(db);
    return { allowed: canUpload(reader.role, u.allowAdults), maxMb: Math.round(u.maxBytes / 1048576) };
  });

  // Uploads take the raw file as the body, so they get their own scope with a catch-all parser.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, _payload, done) => done(null));

    /** PUT /api/uploads?filename=Book.epub with the file as the body. */
    scope.put("/api/uploads", async (req: FastifyRequest, reply) => {
      const reader = requireReader(req);
      const u = getUploadSettings(db);
      if (!canUpload(reader.role, u.allowAdults)) throw httpError(403, "Uploads are for admins");
      const { filename } = parse(UploadQuery, req.query);
      const name = safeFilename(filename);
      if (!isBookFile(name) && !/\.zip$/i.test(name)) {
        throw httpError(415, "Upload an EPUB, KEPUB, MOBI, AZW3, FB2, PDF, CBZ, CBR or TXT file (or a .zip of them)");
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > u.maxBytes) throw httpError(413, `The file is larger than ${Math.round(u.maxBytes / 1048576)} MB`);
      const id = crypto.randomUUID();
      let files: string[];
      try {
        const { tmp } = await writeTemp(opts.booksDir, req.raw, u.maxBytes);
        files = await placeDownload(opts.booksDir, tmp, incomingRel("uploads", id), name);
      } catch (err) {
        if (err instanceof TooLargeError || err instanceof NotABookError) throw httpError(err.statusCode, err.message);
        throw err;
      }
      req.log.info({ files, by: reader.userId }, "upload saved");
      const scanJobId = runner.has(SCAN_JOB) ? runner.enqueue(SCAN_JOB, { reason: "upload" }, { label: `Scan after upload: ${name}` }) : null;
      reply.code(201);
      return { files, scanJobId };
    });
  });
}

/** Admins always; adults and parents when the admin turned that on; kids never. */
export function canUpload(role: string, allowAdults: boolean): boolean {
  return role === "admin" || (allowAdults && (role === "adult" || role === "parent"));
}
