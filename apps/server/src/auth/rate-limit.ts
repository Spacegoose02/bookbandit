/**
 * In-memory lockout for guessable secrets (a 4-digit PIN has 10,000 options).
 * After `freeTries` failures the key is locked for `baseLockMs`, doubling on each
 * further failure up to `maxLockMs`. A success clears the key.
 */
export interface LockoutOptions {
  freeTries?: number;
  baseLockMs?: number;
  maxLockMs?: number;
  now?: () => number;
}

export class Lockout {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();
  private readonly freeTries: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly now: () => number;

  constructor(opts: LockoutOptions = {}) {
    this.freeTries = opts.freeTries ?? 5;
    this.baseLockMs = opts.baseLockMs ?? 60_000;
    this.maxLockMs = opts.maxLockMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Milliseconds until `key` may try again (0 = may try now). */
  retryAfter(key: string): number {
    const e = this.entries.get(key);
    return e ? Math.max(0, e.lockedUntil - this.now()) : 0;
  }

  fail(key: string): void {
    const e = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    e.failures += 1;
    if (e.failures >= this.freeTries) {
      const lock = Math.min(this.maxLockMs, this.baseLockMs * 2 ** (e.failures - this.freeTries));
      e.lockedUntil = this.now() + lock;
    }
    this.entries.set(key, e);
    if (this.entries.size > 10_000) this.prune();
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.lockedUntil < t - this.maxLockMs) this.entries.delete(k);
  }
}

export class TooManyAttemptsError extends Error {
  statusCode = 429;
  constructor(public retryAfterMs: number) {
    super("Too many tries. Wait a little and try again.");
  }
}
