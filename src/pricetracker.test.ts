import { describe, expect, test } from "bun:test";
import {
  DbPriceTracker,
  InMemoryPriceStore,
  bucketKey,
  buildPriceHistory,
  extractFingerprint,
  mileageCompatible,
  normalize,
  resolveMatch,
  type CarRow,
} from "./pricetracker.ts";
import type { Audit, Vehicle } from "./types.ts";

const baseAudit: Omit<Audit, "vehicle" | "priceEur"> = {
  verdict: "good_fit",
  score: 80,
  summary: "x",
  fitChips: [],
  listingSnapshot: "x",
  assessment: [],
  modelYearNotes: [],
  alternatives: [],
};

const auditFor = (vehicle: Vehicle, priceEur: number | null | undefined): Audit => ({
  ...baseAudit,
  vehicle,
  ...(priceEur === undefined ? {} : { priceEur }),
});

const bmw: Vehicle = {
  make: "BMW",
  model: "320d",
  trim: "M Sport",
  year: 2019,
  mileageKm: 100_000,
  fuel: "diesel",
  transmission: "automatic",
  colour: "black",
};

const carRow = (over: Partial<CarRow> = {}): CarRow => ({
  id: "car-1",
  bucketKey: bucketKey(bmw),
  make: "BMW",
  model: "320d",
  trim: "M Sport",
  year: 2019,
  fuel: "diesel",
  transmission: "automatic",
  colour: "black",
  lastMileageKm: 100_000,
  lastPriceEur: 30_000,
  createdAt: "2026-05-01T00:00:00.000Z",
  lastSeenAt: "2026-05-01T00:00:00.000Z",
  ...over,
});

describe("pure helpers", () => {
  test("normalize lowercases and strips punctuation", () => {
    expect(normalize("M-Sport!")).toBe("m sport");
    expect(normalize(undefined)).toBe("");
  });

  test("bucketKey ignores trim/colour/mileage but keys on make/model/year/fuel/transmission", () => {
    const a = bucketKey(bmw);
    expect(a).toBe(bucketKey({ ...bmw, trim: "SE", colour: "white", mileageKm: 5 }));
    expect(a).not.toBe(bucketKey({ ...bmw, year: 2020 }));
    expect(a).not.toBe(bucketKey({ ...bmw, fuel: "petrol" }));
  });

  test("mileageCompatible allows an upward relist and small downward noise", () => {
    expect(mileageCompatible(100_000, 100_000)).toBe(true);
    expect(mileageCompatible(100_000, 108_000)).toBe(true); // within +10%
    expect(mileageCompatible(100_000, 99_000)).toBe(true); // within noise
    expect(mileageCompatible(100_000, 130_000)).toBe(false); // too far up
    expect(mileageCompatible(100_000, 90_000)).toBe(false); // dropped too much
  });

  test("resolveMatch is precision-first: 0 or >1 candidates → no match", () => {
    const c1 = carRow({ id: "a" });
    const c2 = carRow({ id: "b" });
    expect(resolveMatch([], bmw, 100_000)).toBeNull();
    expect(resolveMatch([c1], bmw, 100_000)?.id).toBe("a");
    expect(resolveMatch([c1, c2], bmw, 100_000)).toBeNull(); // ambiguous → new car
  });

  test("resolveMatch rejects on mileage out of tolerance", () => {
    expect(resolveMatch([carRow()], bmw, 130_000)).toBeNull();
  });

  test("extractFingerprint requires make/model/year/mileage/price", () => {
    expect(extractFingerprint(auditFor(bmw, 30_000))).not.toBeNull();
    expect(extractFingerprint(auditFor(bmw, undefined))).toBeNull(); // no price (POA)
    expect(extractFingerprint(auditFor({ ...bmw, mileageKm: undefined }, 30_000))).toBeNull();
    expect(extractFingerprint({ ...baseAudit } as Audit)).toBeNull(); // no vehicle
  });

  test("buildPriceHistory derives current price, change, and last move", () => {
    const h = buildPriceHistory("car-1", [
      { priceEur: 30_000, mileageKm: 100_000, observedAt: "2026-05-01T00:00:00.000Z" },
      { priceEur: 29_000, mileageKm: 101_000, observedAt: "2026-05-10T00:00:00.000Z" },
    ]);
    expect(h?.currentPriceEur).toBe(29_000);
    expect(h?.changeSinceFirstEur).toBe(-1_000);
    expect(h?.lastChange).toEqual({ deltaEur: -1_000, fromPriceEur: 30_000, observedAt: "2026-05-10T00:00:00.000Z" });
  });

  test("buildPriceHistory has no lastChange for a single observation", () => {
    const h = buildPriceHistory("car-1", [{ priceEur: 30_000, mileageKm: 100_000, observedAt: "2026-05-01T00:00:00.000Z" }]);
    expect(h?.lastChange).toBeUndefined();
    expect(h?.changeSinceFirstEur).toBe(0);
  });
});

describe("DbPriceTracker", () => {
  let clock = 0;
  const tracker = (store: InMemoryPriceStore) =>
    new DbPriceTracker(store, () => new Date(2026, 4, 1 + clock++));

  test("first sighting creates a car and one observation", async () => {
    clock = 0;
    const store = new InMemoryPriceStore();
    const h = await tracker(store).record(auditFor(bmw, 30_000), "https://donedeal.ie/a");
    expect(store.cars).toHaveLength(1);
    expect(h?.observations).toHaveLength(1);
    expect(h?.currentPriceEur).toBe(30_000);
  });

  test("recognises the same car relisted under a new URL at a lower price", async () => {
    clock = 0;
    const store = new InMemoryPriceStore();
    const t = tracker(store);
    await t.record(auditFor(bmw, 30_000), "https://donedeal.ie/old");
    // relisted: new URL, driven a bit, price dropped
    const h = await t.record(auditFor({ ...bmw, mileageKm: 104_000 }, 28_500), "https://donedeal.ie/new");
    expect(store.cars).toHaveLength(1); // matched, not duplicated
    expect(h?.observations).toHaveLength(2);
    expect(h?.currentPriceEur).toBe(28_500);
    expect(h?.changeSinceFirstEur).toBe(-1_500);
  });

  test("unchanged price does not add an observation", async () => {
    clock = 0;
    const store = new InMemoryPriceStore();
    const t = tracker(store);
    await t.record(auditFor(bmw, 30_000), "https://donedeal.ie/a");
    const h = await t.record(auditFor({ ...bmw, mileageKm: 101_000 }, 30_000), "https://donedeal.ie/a");
    expect(h?.observations).toHaveLength(1); // no new point
    expect(store.cars[0]!.lastMileageKm).toBe(101_000); // but last_seen mileage bumped
  });

  test("a far-off mileage starts a separate car (precision-first)", async () => {
    clock = 0;
    const store = new InMemoryPriceStore();
    const t = tracker(store);
    await t.record(auditFor(bmw, 30_000), "https://donedeal.ie/a");
    await t.record(auditFor({ ...bmw, mileageKm: 40_000 }, 27_000), "https://donedeal.ie/b");
    expect(store.cars).toHaveLength(2);
  });

  test("returns null (no history) when required fields are missing", async () => {
    const store = new InMemoryPriceStore();
    const h = await new DbPriceTracker(store).record(auditFor(bmw, undefined), "https://donedeal.ie/a");
    expect(h).toBeNull();
    expect(store.cars).toHaveLength(0);
  });

  test("never throws — a store failure yields null", async () => {
    const broken: InMemoryPriceStore = new InMemoryPriceStore();
    broken.findCarsByBucketKey = async () => {
      throw new Error("db down");
    };
    const h = await new DbPriceTracker(broken).record(auditFor(bmw, 30_000), "https://donedeal.ie/a");
    expect(h).toBeNull();
  });
});
