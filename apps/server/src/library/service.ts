/** Runs one library scan at a time and remembers the last report for the admin page. */
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { scanLibrary, type ScanReport } from "./scanner.js";

export interface ScanStatus {
  running: boolean;
  startedAt: number | null;
  progress: { done: number; total: number } | null;
  lastReport: ScanReport | null;
  lastError: string | null;
}

export class LibraryService {
  private current: Promise<ScanReport> | null = null;
  private status: ScanStatus = { running: false, startedAt: null, progress: null, lastReport: null, lastError: null };

  constructor(
    private readonly opts: {
      db: Db;
      booksDir: string;
      configDir: string;
      online: LookupOptions | false;
      log?: FastifyBaseLogger;
    },
  ) {}

  getStatus(): ScanStatus {
    return { ...this.status };
  }

  /** Starts a scan unless one is running; returns the running scan either way. */
  startScan(): Promise<ScanReport> {
    if (this.current) return this.current;
    this.status = { ...this.status, running: true, startedAt: Date.now(), progress: { done: 0, total: 0 }, lastError: null };
    this.current = scanLibrary({
      ...this.opts,
      onProgress: (done, total) => {
        this.status.progress = { done, total };
      },
    })
      .then((report) => {
        this.status.lastReport = report;
        this.opts.log?.info({ added: report.added, removed: report.removed, errors: report.errors.length }, "library scan finished");
        return report;
      })
      .catch((err: unknown) => {
        this.status.lastError = err instanceof Error ? err.message : String(err);
        this.opts.log?.error({ err }, "library scan failed");
        throw err;
      })
      .finally(() => {
        this.status.running = false;
        this.current = null;
      });
    return this.current;
  }
}
