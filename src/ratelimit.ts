// A tiny in-memory fixed-window rate limiter (default: 25 requests per 24h per
// key). Process-local, like the audit cache: a single backend instance enforces
// the limit; multiple instances each track their own counts. The window for a
// key opens on its first request and lasts windowMs, then resets.

interface Window {
  count: number;
  resetAt: number;
}

export interface DailyRateLimiterOptions {
  limit?: number; // max requests per window; 0 (or less) disables the limiter
  windowMs?: number; // window length (default 24h)
  maxEntries?: number; // safety cap on tracked keys (evicts oldest first)
  now?: () => number; // injectable clock for testing
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number; // Infinity when the limiter is disabled
  resetAt: number; // epoch ms when the current window resets
  retryAfterMs: number; // 0 when allowed
}

export class DailyRateLimiter {
  private windows = new Map<string, Window>();
  private limit: number;
  private windowMs: number;
  private maxEntries: number;
  private now: () => number;

  constructor(opts: DailyRateLimiterOptions = {}) {
    this.limit = opts.limit ?? 25;
    this.windowMs = opts.windowMs ?? 86_400_000; // 24h
    this.maxEntries = opts.maxEntries ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  /** Record one request for `key` and report whether it is within the limit. */
  consume(key: string): RateLimitResult {
    const now = this.now();
    if (this.limit <= 0) {
      return { allowed: true, limit: this.limit, remaining: Infinity, resetAt: now, retryAfterMs: 0 };
    }

    let win = this.windows.get(key);
    if (!win || now >= win.resetAt) {
      win = { count: 0, resetAt: now + this.windowMs };
    }
    win.count += 1;
    this.windows.delete(key); // re-insert so this key becomes the newest
    this.windows.set(key, win);
    this.evictIfNeeded(now);

    const allowed = win.count <= this.limit;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - win.count),
      resetAt: win.resetAt,
      retryAfterMs: allowed ? 0 : win.resetAt - now,
    };
  }

  get size(): number {
    return this.windows.size;
  }

  clear(): void {
    this.windows.clear();
  }

  /** Keep memory bounded: drop expired windows first, then the oldest keys. */
  private evictIfNeeded(now: number): void {
    if (this.windows.size <= this.maxEntries) return;
    for (const [key, win] of this.windows) {
      if (this.windows.size <= this.maxEntries) break;
      if (now >= win.resetAt) this.windows.delete(key);
    }
    while (this.windows.size > this.maxEntries) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}
