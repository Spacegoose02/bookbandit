/**
 * Librarian tools (ws/librarian): duplicates, bulk edit, conversion, covers and library health.
 * Registered from app.ts after jobsPlugin. See README.md in this folder.
 */
import type { FastifyInstance } from "fastify";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { KepubConverter } from "../kobo/kepub.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { commandAvailable, ebookConvert, registerConvertJobs, type ConvertFn } from "./convert.js";
import { registerHealthJob } from "./health.js";
import { librarianRoutes } from "./routes.js";

export interface LibrarianOptions {
  db: Db;
  config: Config;
  resolveLookup: () => LookupOptions | false;
  /** Shared with the Kobo routes so both use one cache and one in-flight map. */
  kepub?: KepubConverter;
  /** Tests: a fake ebook-convert. */
  convert?: ConvertFn;
  /** Tests: pretend the tools are (not) installed. */
  tools?: () => Promise<{ ebookConvert: boolean; kepubify: boolean }>;
  fetchImpl?: typeof fetch;
}

export async function librarianPlugin(app: FastifyInstance, opts: LibrarianOptions) {
  if (!app.hasDecorator("jobs")) throw new Error("librarianPlugin needs jobsPlugin registered first");
  const { db, config } = opts;
  const booksRoot = resolve(config.BOOKS_DIR);
  const kepub = opts.kepub ?? new KepubConverter(config.KEPUBIFY_PATH, join(config.CONFIG_DIR, "cache"), app.log);
  const tools =
    opts.tools ??
    (async () => {
      const [ebook, kepubify] = await Promise.all([commandAvailable(config.EBOOK_CONVERT_PATH), kepub.isAvailable()]);
      return { ebookConvert: ebook, kepubify };
    });

  registerConvertJobs(app.jobs, { db, booksRoot, convert: opts.convert ?? ebookConvert(config.EBOOK_CONVERT_PATH), kepub });
  registerHealthJob(app.jobs, { db, booksRoot });

  await app.register(librarianRoutes, {
    db,
    booksRoot,
    configDir: config.CONFIG_DIR,
    resolveLookup: opts.resolveLookup,
    fetchImpl: opts.fetchImpl ?? fetch,
    tools,
  });
}
