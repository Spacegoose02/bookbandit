/** Runs one audiobook scan at a time and remembers the last report for the admin page. */
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { scanAudiobooks, type AudioScanReport } from "./scanner.js";

export interface AudioScanStatus {
  running: boolean;
  startedAt: number | null;
  progress: { done: number; total: number } | null;
  lastReport: AudioScanReport | null;
  lastError: string | null;
}

export class AudiobookService {
  private current: Promise<AudioScanReport> | null = null;
  private status: AudioScanStatus = { running: false, startedAt: null, progress: null, lastReport: null, lastError: null };

  constructor(
    private readonly opts: {
      db: Db;
      audiobooksDir: string;
      configDir: string;
      online: () => LookupOptions | false;
      log?: FastifyBaseLogger;
    },
  ) {}

  getStatus(): AudioScanStatus {
    return { ...this.status };
  }

  startScan(): Promise<AudioScanReport> {
    if (this.current) return this.current;
    this.status = { ...this.status, running: true, startedAt: Date.now(), progress: { done: 0, total: 0 }, lastError: null };
    this.current = scanAudiobooks({
      db: this.opts.db,
      audiobooksDir: this.opts.audiobooksDir,
      configDir: this.opts.configDir,
      online: this.opts.online(),
      onProgress: (done, total) => {
        this.status.progress = { done, total };
      },
    })
      .then((report) => {
        this.status.lastReport = report;
        this.opts.log?.info({ added: report.added, linked: report.linked, removed: report.removed, errors: report.errors.length }, "audiobook scan finished");
        return report;
      })
      .catch((err: unknown) => {
        this.status.lastError = err instanceof Error ? err.message : String(err);
        this.opts.log?.error({ err }, "audiobook scan failed");
        throw err;
      })
      .finally(() => {
        this.status.running = false;
        this.current = null;
      });
    return this.current;
  }
}
