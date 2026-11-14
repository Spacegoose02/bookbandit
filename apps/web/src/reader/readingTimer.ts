/**
 * Counts active reading time and reports it to the server about once a minute.
 * "Active" means the tab is visible and the reader touched, scrolled or turned a page in the
 * last few minutes, so a book left open overnight doesn't count as reading.
 */
import type { Api } from "../api/client";

export const TICK_MS = 15_000;
export const SEND_EVERY_MS = 60_000;
/** Without any input for this long, the reader is treated as away. */
export const IDLE_AFTER_MS = 3 * 60_000;

export interface TimerEnv {
  now(): number;
  visible(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const browserEnv: TimerEnv = {
  now: () => Date.now(),
  visible: () => document.visibilityState === "visible",
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id as number),
};

export class ReadingTimer {
  readonly sessionId = crypto.randomUUID();
  private lastActivity: number;
  private lastSend: number;
  private pendingSeconds = 0;
  private interval: unknown;

  constructor(
    private api: Pick<Api, "readingHeartbeat">,
    private bookId: string,
    private opts: { deviceName?: string; kind?: "read" | "listen"; env?: TimerEnv } = {},
  ) {
    const env = this.env;
    this.lastActivity = env.now();
    this.lastSend = env.now();
    this.interval = env.setInterval(() => this.tick(), TICK_MS);
  }

  private get env(): TimerEnv {
    return this.opts.env ?? browserEnv;
  }

  /** Call on any reader input: page turn, tap, key, scroll. */
  touch(): void {
    this.lastActivity = this.env.now();
  }

  tick(): void {
    const t = this.env.now();
    if (this.env.visible() && t - this.lastActivity <= IDLE_AFTER_MS) this.pendingSeconds += TICK_MS / 1000;
    if (t - this.lastSend >= SEND_EVERY_MS) void this.flush();
  }

  /** Send what has built up. Safe to call often; does nothing when there's nothing to send. */
  async flush(opts?: { keepalive?: boolean }): Promise<void> {
    this.lastSend = this.env.now();
    const seconds = Math.min(300, Math.round(this.pendingSeconds));
    if (seconds < 1) return;
    this.pendingSeconds = 0;
    try {
      await this.api.readingHeartbeat(
        { sessionId: this.sessionId, bookId: this.bookId, seconds, kind: this.opts.kind ?? "read", deviceName: this.opts.deviceName },
        opts,
      );
    } catch {
      // Offline or server hiccup: keep the time for the next try.
      this.pendingSeconds += seconds;
    }
  }

  dispose(): void {
    this.env.clearInterval(this.interval);
  }
}
