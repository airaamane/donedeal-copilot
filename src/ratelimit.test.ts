import { describe, expect, test } from "bun:test";
import { DailyRateLimiter } from "./ratelimit.ts";

describe("DailyRateLimiter", () => {
  test("allows up to the limit then blocks", () => {
    const rl = new DailyRateLimiter({ limit: 2 });
    expect(rl.consume("ip").allowed).toBe(true);
    expect(rl.consume("ip").allowed).toBe(true);
    const third = rl.consume("ip");
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  test("tracks keys independently", () => {
    const rl = new DailyRateLimiter({ limit: 1 });
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(false);
    expect(rl.consume("b").allowed).toBe(true); // different key, fresh window
  });

  test("resets after the window elapses", () => {
    let now = 1000;
    const rl = new DailyRateLimiter({ limit: 1, windowMs: 100, now: () => now });
    expect(rl.consume("ip").allowed).toBe(true);
    expect(rl.consume("ip").allowed).toBe(false);
    now = 1100; // window elapsed
    expect(rl.consume("ip").allowed).toBe(true);
  });

  test("reports remaining and reset time", () => {
    let now = 5000;
    const rl = new DailyRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    const first = rl.consume("ip");
    expect(first.remaining).toBe(2);
    expect(first.resetAt).toBe(6000);
  });

  test("a limit of 0 disables the limiter", () => {
    const rl = new DailyRateLimiter({ limit: 0 });
    for (let i = 0; i < 100; i++) expect(rl.consume("ip").allowed).toBe(true);
    expect(rl.size).toBe(0);
  });

  test("evicts oldest keys past maxEntries", () => {
    const rl = new DailyRateLimiter({ limit: 5, maxEntries: 2 });
    rl.consume("a");
    rl.consume("b");
    rl.consume("c"); // evicts "a"
    expect(rl.size).toBe(2);
  });
});
