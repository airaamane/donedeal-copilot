import { describe, expect, test } from "bun:test";
import {
  AuditError,
  CapacityError,
  isAudit,
  runAudit,
  runAuditCached,
  stripCodeFence,
  type GenerateFn,
} from "./audit.ts";
import { TtlCache } from "./cache.ts";
import { DailyRateLimiter } from "./ratelimit.ts";
import type { Audit } from "./types.ts";

const URL = "https://www.donedeal.ie/cars-for-sale/bmw/42108822";

const validAudit: Audit = {
  verdict: "proceed_with_caution",
  market: "ie",
  score: 62,
  summary: "Solid spec for the budget, but it's a UK import with no Irish history yet.",
  fitChips: [
    { label: "€50 under budget", status: "match" },
    { label: "118k km — high", status: "neutral" },
  ],
  listingSnapshot: "2019 BMW 320d xDrive M Sport, 118k km, €29,950 at a Cork dealer.",
  assessment: [
    { title: "No Irish history", detail: "VRT-pending import — worth a Cartell/Motorcheck report." },
  ],
  modelYearNotes: [
    { title: "G20 B47 engine", detail: "Generally reliable; pre-LCI infotainment is older." },
  ],
  alternatives: [
    {
      car: "BMW 320d M Sport (G20, 2021+ LCI)",
      sameModelNewerYear: true,
      reason: "Facelift improves infotainment and adds mild-hybrid for the same use.",
    },
  ],
};

const isExtraction = (args: Parameters<GenerateFn>[0]) =>
  Boolean((args.config as Record<string, unknown>).tools);

// Mock: stage 1 (extraction, has tools) returns listing markdown;
// stage 2 (audit, no tools) returns `auditText`.
const stubbed = (auditText: string | undefined): GenerateFn => {
  return async (args) => ({
    text: isExtraction(args) ? "### Vehicle\n* Price: €29,950" : auditText,
  });
};

describe("runAudit", () => {
  test("returns the parsed audit on valid JSON output", async () => {
    const audit = await runAudit({ budgetMax: 30000 }, URL, {
      generate: stubbed(JSON.stringify(validAudit)),
    });
    expect(audit).toEqual(validAudit);
  });

  test("parses JSON wrapped in a markdown code fence", async () => {
    const fenced = "```json\n" + JSON.stringify(validAudit) + "\n```";
    const audit = await runAudit({}, URL, { generate: stubbed(fenced) });
    expect(audit).toEqual(validAudit);
  });

  test("runs two stages: urlContext read then schema-enforced audit", async () => {
    const calls: Parameters<GenerateFn>[0][] = [];
    const generate: GenerateFn = async (args) => {
      calls.push(args);
      return { text: isExtraction(args) ? "### Vehicle" : JSON.stringify(validAudit) };
    };
    await runAudit({ budgetMax: 30000 }, URL, { generate });

    expect(calls).toHaveLength(2);

    // Stage 1: reads the URL with the urlContext tool, no schema.
    const stage1 = calls[0]!;
    expect(stage1.model).toBe("gemini-3.5-flash");
    expect(stage1.contents).toContain(URL);
    expect((stage1.config as any).tools).toEqual([{ urlContext: {} }]);
    expect((stage1.config as any).responseFormat).toBeUndefined();

    // Stage 2: audits with an enforced schema and NO tools.
    const stage2 = calls[1]!;
    expect(stage2.contents).toContain("BUYER PROFILE:");
    expect((stage2.config as any).tools).toBeUndefined();
    expect((stage2.config as any).responseMimeType).toBe("application/json");
    expect((stage2.config as any).responseJsonSchema).toBeDefined();
  });

  test("supplied listingText skips the urlContext read stage", async () => {
    const calls: Parameters<GenerateFn>[0][] = [];
    const generate: GenerateFn = async (args) => {
      calls.push(args);
      return { text: JSON.stringify(validAudit) };
    };
    await runAudit({ budgetMax: 30000 }, URL, {
      generate,
      listingText: "### Vehicle\n* Price: £9,995\n* Mileage: 114,777 miles",
    });

    // Only stage 2 (the audit) ran — no extraction/urlContext call.
    expect(calls).toHaveLength(1);
    expect((calls[0]!.config as any).tools).toBeUndefined();
    expect(calls[0]!.contents).toContain("£9,995");
  });

  test("blank listingText falls back to the urlContext read stage", async () => {
    const calls: Parameters<GenerateFn>[0][] = [];
    const generate: GenerateFn = async (args) => {
      calls.push(args);
      return { text: isExtraction(args) ? "### Vehicle" : JSON.stringify(validAudit) };
    };
    await runAudit({}, URL, { generate, listingText: "   " });
    expect(calls).toHaveLength(2); // both stages ran
  });

  test("throws AuditError on empty audit response", async () => {
    await expect(runAudit({}, URL, { generate: stubbed("") })).rejects.toBeInstanceOf(AuditError);
  });

  test("throws AuditError on non-JSON audit output", async () => {
    await expect(
      runAudit({}, URL, { generate: stubbed("not json") }),
    ).rejects.toBeInstanceOf(AuditError);
  });

  test("throws AuditError on schema-invalid audit output", async () => {
    await expect(
      runAudit({}, URL, { generate: stubbed(JSON.stringify({ verdict: "maybe" })) }),
    ).rejects.toBeInstanceOf(AuditError);
  });

  test("throws AuditError when the read stage rejects", async () => {
    const generate: GenerateFn = async () => {
      throw new Error("network down");
    };
    await expect(runAudit({}, URL, { generate })).rejects.toBeInstanceOf(AuditError);
  });

  test("throws AuditError when the read stage times out", async () => {
    const generate: GenerateFn = () => new Promise(() => {}); // never resolves
    await expect(
      runAudit({}, URL, { generate, extractTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(AuditError);
  });
});

describe("runAuditCached", () => {
  test("serves a repeat (profile, url) from cache without re-calling Gemini", async () => {
    let calls = 0;
    const generate: GenerateFn = async (args) => {
      calls++;
      return { text: isExtraction(args) ? "### Vehicle" : JSON.stringify(validAudit) };
    };
    const cache = new TtlCache<Audit>();

    const first = await runAuditCached({ budgetMax: 30000 }, URL, { generate, cache });
    const second = await runAuditCached({ budgetMax: 30000 }, URL, { generate, cache });

    expect(first).toEqual(validAudit);
    expect(second).toEqual(validAudit);
    expect(calls).toBe(2); // only the first audit hit Gemini (2 stages); second was cached
  });

  test("misses the cache for a different profile", async () => {
    let calls = 0;
    const generate: GenerateFn = async (args) => {
      calls++;
      return { text: isExtraction(args) ? "### Vehicle" : JSON.stringify(validAudit) };
    };
    const cache = new TtlCache<Audit>();

    await runAuditCached({ budgetMax: 30000 }, URL, { generate, cache });
    await runAuditCached({ budgetMax: 25000 }, URL, { generate, cache });

    expect(calls).toBe(4); // two separate audits, 2 stages each
  });

  test("attaches priceHistory from the tracker on a fresh audit", async () => {
    const history = {
      carId: "car-1",
      market: "ie" as const,
      observations: [{ price: 29950, mileageKm: 118000, observedAt: "2026-05-24T00:00:00.000Z" }],
      firstSeenAt: "2026-05-24T00:00:00.000Z",
      lastSeenAt: "2026-05-24T00:00:00.000Z",
      currentPrice: 29950,
      changeSinceFirst: 0,
    };
    const tracker = { record: async () => history };
    const audit = await runAuditCached({ budgetMax: 30000 }, URL, {
      generate: stubbed(JSON.stringify(validAudit)),
      cache: new TtlCache<Audit>(),
      tracker,
    });
    expect(audit.priceHistory).toEqual(history);
  });

  test("a throwing tracker never breaks the audit", async () => {
    const tracker = {
      record: async () => {
        throw new Error("tracker exploded");
      },
    };
    const audit = await runAuditCached({ budgetMax: 30000 }, URL, {
      generate: stubbed(JSON.stringify(validAudit)),
      cache: new TtlCache<Audit>(),
      tracker,
    });
    expect(audit.verdict).toBe(validAudit.verdict);
    expect(audit.priceHistory).toBeUndefined();
  });

  test("throws CapacityError once the global daily audit cap is reached", async () => {
    const globalLimiter = new DailyRateLimiter({ limit: 1 });
    const opts = {
      generate: stubbed(JSON.stringify(validAudit)),
      cache: new TtlCache<Audit>(),
      globalLimiter,
    };
    // First fresh audit is within the cap; a second *different* one is over it.
    await runAuditCached({ budgetMax: 30000 }, URL, opts);
    await expect(
      runAuditCached({ budgetMax: 25000 }, URL, opts),
    ).rejects.toBeInstanceOf(CapacityError);
  });

  test("cache hits do not count against the global cap", async () => {
    const globalLimiter = new DailyRateLimiter({ limit: 1 });
    const cache = new TtlCache<Audit>();
    const opts = { generate: stubbed(JSON.stringify(validAudit)), cache, globalLimiter };

    // One fresh audit (uses the only slot), then the same request repeatedly —
    // all served from cache, so the cap is never consumed again.
    await runAuditCached({ budgetMax: 30000 }, URL, opts);
    const repeat1 = await runAuditCached({ budgetMax: 30000 }, URL, opts);
    const repeat2 = await runAuditCached({ budgetMax: 30000 }, URL, opts);
    expect(repeat1).toEqual(validAudit);
    expect(repeat2).toEqual(validAudit);

    // A *new* fresh audit is still correctly blocked — the slot was only spent once.
    await expect(
      runAuditCached({ budgetMax: 25000 }, URL, opts),
    ).rejects.toBeInstanceOf(CapacityError);
  });
});

describe("stripCodeFence", () => {
  test("removes ```json fences and plain ``` fences, leaves bare JSON untouched", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("isAudit", () => {
  test("accepts a well-formed audit", () => {
    expect(isAudit(validAudit)).toBe(true);
  });

  test("rejects bad verdict, missing arrays, and non-objects", () => {
    expect(isAudit({ ...validAudit, verdict: "nope" })).toBe(false);
    expect(isAudit({ ...validAudit, assessment: "x" })).toBe(false);
    expect(isAudit({ ...validAudit, score: "high" })).toBe(false);
    expect(isAudit({ ...validAudit, fitChips: [{ label: "x" }] })).toBe(false);
    expect(isAudit({ ...validAudit, alternatives: [{ car: "x" }] })).toBe(false);
    expect(isAudit(null)).toBe(false);
  });

  test("rejects a bad or missing market", () => {
    expect(isAudit({ ...validAudit, market: "fr" })).toBe(false);
    const { market, ...withoutMarket } = validAudit;
    expect(isAudit(withoutMarket)).toBe(false);
    expect(isAudit({ ...validAudit, market: "uk" })).toBe(true);
  });
});
