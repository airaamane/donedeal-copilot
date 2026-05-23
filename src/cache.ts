// A tiny in-memory TTL cache with a max-entry cap (evicts oldest first).
// Process-local: a single backend instance shares it; multiple instances do not.

import type { Profile } from "./types.ts";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number; // injectable clock for testing
}

export class TtlCache<V> {
  private store = new Map<string, Entry<V>>();
  private ttlMs: number;
  private maxEntries: number;
  private now: () => number;

  constructor(opts: TtlCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 3_600_000; // 1 hour
    this.maxEntries = opts.maxEntries ?? 500;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.store.delete(key); // re-insert so this key becomes the newest
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Stable cache key for an audit: the listing URL plus the profile with its keys
 * sorted, so logically-equal profiles (different key order) share a cache entry.
 */
export function auditCacheKey(profile: Profile, url: string): string {
  const sortedKeys = Object.keys(profile).sort();
  return `${url}::${JSON.stringify(profile, sortedKeys)}`;
}
