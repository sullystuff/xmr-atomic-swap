/**
 * Per-IP limits (SPEC 6.5: default 60 requests and 4 MB per minute), fixed one-minute windows.
 * State is in memory only and an address is forgotten once its window has passed.
 */
export interface RateLimitOptions {
  requestsPerMinute: number;
  bytesPerMinute: number;
  now?: () => number;
}

interface Window {
  start: number;
  requests: number;
  bytes: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(private readonly opts: RateLimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  private window(ip: string): Window {
    const now = this.now();
    if (now - this.lastSweep >= WINDOW_MS) {
      this.lastSweep = now;
      for (const [k, w] of this.windows) if (now - w.start >= WINDOW_MS) this.windows.delete(k);
    }
    let w = this.windows.get(ip);
    if (!w || now - w.start >= WINDOW_MS) {
      w = { start: now, requests: 0, bytes: 0 };
      this.windows.set(ip, w);
    }
    return w;
  }

  /**
   * Admit one request, or refuse it. A request is refused when the address has used its request
   * count or its byte budget for the current window.
   */
  admit(ip: string): boolean {
    const w = this.window(ip);
    if (w.requests >= this.opts.requestsPerMinute || w.bytes >= this.opts.bytesPerMinute) return false;
    w.requests += 1;
    return true;
  }

  /** Would `extra` more bytes exceed the budget? Used before an upstream call is made. */
  hasBudget(ip: string, extra: number): boolean {
    return this.window(ip).bytes + extra <= this.opts.bytesPerMinute;
  }

  /** Charge bytes carried for this address (request bodies and relayed responses). */
  charge(ip: string, bytes: number): void {
    this.window(ip).bytes += bytes;
  }

  /** Seconds until the address's window ends. */
  retryAfterSecs(ip: string): number {
    const w = this.windows.get(ip);
    if (!w) return 0;
    return Math.max(1, Math.ceil((w.start + WINDOW_MS - this.now()) / 1000));
  }

  /** Number of addresses currently tracked (tests). */
  get tracked(): number {
    return this.windows.size;
  }
}
