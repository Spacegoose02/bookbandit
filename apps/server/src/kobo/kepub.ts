/**
 * EPUB → KEPUB with kepubify (bundled in the Docker image), cached under
 * CONFIG_DIR/cache/kepub. The original file is never touched (CLAUDE.md rule 6).
 * Conversion runs inline on first download; TODO(jobs): pre-convert in the job runner.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface KepubSource {
  id: string;
  sizeBytes: number;
  mtimeMs: number | null;
}

export class KepubConverter {
  private available: Promise<boolean> | null = null;
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly kepubifyPath: string,
    private readonly cacheDir: string,
    private readonly log: { warn: (obj: unknown, msg?: string) => void } = console,
  ) {}

  /** Whether kepubify runs here (checked once). */
  isAvailable(): Promise<boolean> {
    this.available ??= new Promise((resolve) => {
      execFile(this.kepubifyPath, ["--version"], { timeout: 10_000 }, (err) => resolve(!err));
    });
    return this.available;
  }

  /** Path of the cached KEPUB for an EPUB, converting it first if needed; null if that fails. */
  async convert(abs: string, file: KepubSource): Promise<string | null> {
    if (!(await this.isAvailable())) return null;
    const dir = join(this.cacheDir, "kepub");
    const out = join(dir, `${file.id}-${file.sizeBytes}-${Math.floor(file.mtimeMs ?? 0)}.kepub.epub`);
    if (await stat(out).then((s) => s.isFile(), () => false)) return out;
    const pending = this.inFlight.get(out);
    if (pending) return pending;
    const job = (async () => {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}.kepub.epub`);
      try {
        await new Promise<void>((resolve, reject) =>
          execFile(this.kepubifyPath, ["-o", tmp, abs], { timeout: 180_000 }, (err) => (err ? reject(err) : resolve())),
        );
        await rename(tmp, out);
        return out;
      } catch (err) {
        this.log.warn({ err, file: file.id }, "kepubify failed; sending the EPUB instead");
        await rm(tmp, { force: true });
        return null;
      }
    })().finally(() => this.inFlight.delete(out));
    this.inFlight.set(out, job);
    return job;
  }
}
