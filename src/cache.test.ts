import { describe, expect, test } from "bun:test";
import { TtlCache, auditCacheKey } from "./cache.ts";

describe("TtlCache", () => {
  test("stores and retrieves values", () => {
    const cache = new TtlCache<number>();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("expires entries after the TTL", () => {
    let now = 1000;
    const cache = new TtlCache<number>({ ttlMs: 100, now: () => now });
    cache.set("a", 1);
    now = 1099;
    expect(cache.get("a")).toBe(1); // still inside TTL
    now = 1100;
    expect(cache.get("a")).toBeUndefined(); // expired
  });

  test("evicts the oldest entry past maxEntries", () => {
    const cache = new TtlCache<number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  test("clear empties the cache", () => {
    const cache = new TtlCache<number>();
    cache.set("a", 1);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe("auditCacheKey", () => {
  const url = "https://www.donedeal.ie/cars-for-sale/bmw/42108822";

  test("is stable regardless of profile key order", () => {
    const k1 = auditCacheKey({ budgetMax: 30000, fuel: "diesel" }, url);
    const k2 = auditCacheKey({ fuel: "diesel", budgetMax: 30000 }, url);
    expect(k1).toBe(k2);
  });

  test("differs by url and by profile", () => {
    const base = auditCacheKey({ budgetMax: 30000 }, url);
    expect(auditCacheKey({ budgetMax: 30000 }, url + "x")).not.toBe(base);
    expect(auditCacheKey({ budgetMax: 25000 }, url)).not.toBe(base);
  });
});
