/**
 * Per-IP limits, fixed one-minute windows, one counter per class of request. State is in memory
 * only and an address is forgotten once its window has passed.
 */
const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Admit one request from `ip`, or refuse it. */
  admit(ip: string): boolean {
    const now = this.now();
    if (now - this.lastSweep >= WINDOW_MS) {
      this.lastSweep = now;
      for (const [k, w] of this.windows) if (now - w.start >= WINDOW_MS) this.windows.delete(k);
    }
    let w = this.windows.get(ip);
    if (!w || now - w.start >= WINDOW_MS) {
      w = { start: now, count: 0 };
      this.windows.set(ip, w);
    }
    if (w.count >= this.perMinute) return false;
    w.count += 1;
    return true;
  }

  /** Seconds until the address's window ends. */
  retryAfterSecs(ip: string): number {
    const w = this.windows.get(ip);
    return w ? Math.max(1, Math.ceil((w.start + WINDOW_MS - this.now()) / 1000)) : 1;
  }

  get tracked(): number {
    return this.windows.size;
  }
}
