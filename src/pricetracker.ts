// Price tracking: fingerprint a car from its audit, match it against a registry
// of cars seen before (surviving relists under new URLs), and record price
// points over time. See docs/superpowers/specs/2026-05-24-car-price-tracking-design.md
//
// Everything here is best-effort: `record` never throws — a tracking failure
// returns null so the audit it rides on is unaffected.

import { SQL } from "bun";
import type { Audit, Market, PriceHistory, PriceObservation, Vehicle } from "./types.ts";

// --- Matching tunables (km) --------------------------------------------------
const MILEAGE_NOISE_KM = 2_000; // tolerated downward wobble from data-entry noise
const MILEAGE_TOLERANCE_KM = 8_000; // absolute upward allowance between relists
const MILEAGE_TOLERANCE_FRAC = 0.1; // or 10% of stored mileage, whichever is larger

// --- Persistence shapes ------------------------------------------------------

export interface NewCar {
  bucketKey: string;
  market: Market;
  make: string;
  model: string;
  trim: string | null;
  year: number;
  fuel: string | null;
  transmission: string | null;
  colour: string | null;
  lastMileageKm: number;
  lastPrice: number; // native currency for the market (GBP for uk, EUR for ie)
  createdAt: string;
  lastSeenAt: string;
}

export interface CarRow extends NewCar {
  id: string;
}

/** Raw persistence operations. The matching/orchestration logic lives in the
 *  tracker; a store just reads and writes rows. */
export interface PriceStore {
  findCarsByBucketKey(key: string): Promise<CarRow[]>;
  insertCar(car: NewCar): Promise<CarRow>;
  insertObservation(
    carId: string,
    price: number,
    mileageKm: number,
    sourceUrl: string,
    observedAt: string,
  ): Promise<void>;
  /** Price changed: update the denormalized last_* fields. */
  updateCarOnPriceChange(
    carId: string,
    patch: { lastPrice: number; lastMileageKm: number; lastSeenAt: string },
  ): Promise<void>;
  /** Price unchanged: just record that the car is still listed. */
  touchCar(carId: string, lastSeenAt: string, lastMileageKm: number): Promise<void>;
  getObservations(carId: string): Promise<PriceObservation[]>;
}

export interface PriceTracker {
  record(audit: Audit, sourceUrl: string): Promise<PriceHistory | null>;
}

/** Used when no database is configured: tracking is silently disabled. */
export const noopPriceTracker: PriceTracker = {
  async record() {
    return null;
  },
};

// --- Pure helpers (exported for unit testing) --------------------------------

/** Lowercase, strip punctuation, collapse whitespace — for stable comparison. */
export function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Coarse bucket key: the stable, low-cardinality fields, scoped by market so a
 *  UK and an Irish car of the same make/model/year never share a bucket (their
 *  prices are in different currencies). Trim/colour/mileage are NOT in the key
 *  (they discriminate within a bucket instead). */
export function bucketKey(v: Vehicle, market: Market): string {
  return [market, normalize(v.make), normalize(v.model), String(v.year), normalize(v.fuel), normalize(v.transmission)].join("|");
}

/** Mileage only climbs between relists, so the window is directional: a small
 *  downward tolerance for data-entry noise, a larger upward one for driving. */
export function mileageCompatible(storedKm: number, candidateKm: number): boolean {
  const lower = storedKm - MILEAGE_NOISE_KM;
  const upper = storedKm + Math.max(MILEAGE_TOLERANCE_KM, storedKm * MILEAGE_TOLERANCE_FRAC);
  return candidateKm >= lower && candidateKm <= upper;
}

/** Two optional text fields "agree" if either is blank or they normalize equal. */
function softAgrees(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na === "" || nb === "" || na === nb;
}

/**
 * Precision-first resolution among same-bucket candidates: a car matches only
 * when exactly one candidate is mileage-compatible and agrees on trim+colour.
 * Zero or multiple → no match (caller creates a new car) — a wrong merge is
 * worse than a missed one.
 */
export function resolveMatch(candidates: CarRow[], v: Vehicle, mileageKm: number): CarRow | null {
  const matches = candidates.filter(
    (c) =>
      mileageCompatible(c.lastMileageKm, mileageKm) &&
      softAgrees(c.trim, v.trim) &&
      softAgrees(c.colour, v.colour),
  );
  return matches.length === 1 ? matches[0]! : null;
}

export interface Fingerprint {
  vehicle: Vehicle;
  mileageKm: number;
  price: number;
  market: Market;
}

/** Pull the fields needed to track a price point, or null if any are missing
 *  (e.g. a POA listing, or a page that wasn't a real car listing). */
export function extractFingerprint(audit: Audit): Fingerprint | null {
  const v = audit.vehicle;
  if (!v || typeof v.make !== "string" || typeof v.model !== "string" || typeof v.year !== "number") {
    return null;
  }
  if (typeof v.mileageKm !== "number") return null;
  if (typeof audit.price !== "number") return null;
  return { vehicle: v, mileageKm: v.mileageKm, price: audit.price, market: audit.market };
}

/** Build the response-facing history from a car's stored observations. Prices
 *  are in the car's native currency, indicated by `market`. */
export function buildPriceHistory(
  carId: string,
  market: Market,
  observations: PriceObservation[],
): PriceHistory | null {
  if (observations.length === 0) return null;
  const sorted = [...observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const history: PriceHistory = {
    carId,
    market,
    observations: sorted,
    firstSeenAt: first.observedAt,
    lastSeenAt: last.observedAt,
    currentPrice: last.price,
    changeSinceFirst: last.price - first.price,
  };
  if (sorted.length >= 2) {
    const prev = sorted[sorted.length - 2]!;
    history.lastChange = {
      delta: last.price - prev.price,
      fromPrice: prev.price,
      observedAt: last.observedAt,
    };
  }
  return history;
}

// --- Tracker -----------------------------------------------------------------

/** Records price points against a {@link PriceStore} and returns the car's
 *  history. Store-agnostic, so it's unit-tested against an in-memory store. */
export class DbPriceTracker implements PriceTracker {
  constructor(
    private readonly store: PriceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(audit: Audit, sourceUrl: string): Promise<PriceHistory | null> {
    try {
      const fp = extractFingerprint(audit);
      if (!fp) return null;

      const nowIso = this.now().toISOString();
      const key = bucketKey(fp.vehicle, fp.market);
      const candidates = await this.store.findCarsByBucketKey(key);
      const matched = resolveMatch(candidates, fp.vehicle, fp.mileageKm);

      let carId: string;
      if (!matched) {
        const car = await this.store.insertCar({
          bucketKey: key,
          market: fp.market,
          make: fp.vehicle.make,
          model: fp.vehicle.model,
          trim: fp.vehicle.trim ?? null,
          year: fp.vehicle.year,
          fuel: fp.vehicle.fuel ?? null,
          transmission: fp.vehicle.transmission ?? null,
          colour: fp.vehicle.colour ?? null,
          lastMileageKm: fp.mileageKm,
          lastPrice: fp.price,
          createdAt: nowIso,
          lastSeenAt: nowIso,
        });
        carId = car.id;
        await this.store.insertObservation(carId, fp.price, fp.mileageKm, sourceUrl, nowIso);
      } else {
        carId = matched.id;
        const lastMileageKm = Math.max(matched.lastMileageKm, fp.mileageKm);
        if (fp.price !== matched.lastPrice) {
          await this.store.insertObservation(carId, fp.price, fp.mileageKm, sourceUrl, nowIso);
          await this.store.updateCarOnPriceChange(carId, {
            lastPrice: fp.price,
            lastMileageKm,
            lastSeenAt: nowIso,
          });
        } else {
          await this.store.touchCar(carId, nowIso, lastMileageKm);
        }
      }

      return buildPriceHistory(carId, fp.market, await this.store.getObservations(carId));
    } catch (err) {
      console.error("price tracking failed:", err);
      return null;
    }
  }
}

// --- In-memory store (tests / dev) -------------------------------------------

export class InMemoryPriceStore implements PriceStore {
  readonly cars: CarRow[] = [];
  private readonly obs = new Map<string, PriceObservation[]>();
  private seq = 0;

  async findCarsByBucketKey(key: string): Promise<CarRow[]> {
    return this.cars.filter((c) => c.bucketKey === key);
  }

  async insertCar(car: NewCar): Promise<CarRow> {
    const row: CarRow = { id: `car-${++this.seq}`, ...car };
    this.cars.push(row);
    this.obs.set(row.id, []);
    return row;
  }

  async insertObservation(
    carId: string,
    price: number,
    mileageKm: number,
    _sourceUrl: string,
    observedAt: string,
  ): Promise<void> {
    this.obs.get(carId)?.push({ price, mileageKm, observedAt });
  }

  async updateCarOnPriceChange(
    carId: string,
    patch: { lastPrice: number; lastMileageKm: number; lastSeenAt: string },
  ): Promise<void> {
    const car = this.cars.find((c) => c.id === carId);
    if (!car) return;
    car.lastPrice = patch.lastPrice;
    car.lastMileageKm = patch.lastMileageKm;
    car.lastSeenAt = patch.lastSeenAt;
  }

  async touchCar(carId: string, lastSeenAt: string, lastMileageKm: number): Promise<void> {
    const car = this.cars.find((c) => c.id === carId);
    if (!car) return;
    car.lastSeenAt = lastSeenAt;
    car.lastMileageKm = lastMileageKm;
  }

  async getObservations(carId: string): Promise<PriceObservation[]> {
    return this.obs.get(carId) ?? [];
  }
}

// --- Postgres store (Railway) ------------------------------------------------

interface CarDbRow {
  id: string;
  bucket_key: string;
  market: string;
  make: string;
  model: string;
  trim: string | null;
  year: number;
  fuel: string | null;
  transmission: string | null;
  colour: string | null;
  last_mileage_km: number;
  last_price: number;
  created_at: string;
  last_seen_at: string;
}

function toCarRow(r: CarDbRow): CarRow {
  return {
    id: r.id,
    bucketKey: r.bucket_key,
    market: r.market as Market,
    make: r.make,
    model: r.model,
    trim: r.trim,
    year: r.year,
    fuel: r.fuel,
    transmission: r.transmission,
    colour: r.colour,
    lastMileageKm: r.last_mileage_km,
    lastPrice: r.last_price,
    createdAt: typeof r.created_at === "string" ? r.created_at : new Date(r.created_at).toISOString(),
    lastSeenAt: typeof r.last_seen_at === "string" ? r.last_seen_at : new Date(r.last_seen_at).toISOString(),
  };
}

/** Postgres-backed store via Bun's built-in SQL. Tables are created lazily on
 *  first use (CREATE TABLE IF NOT EXISTS) — no migration tooling for v1. */
export class PostgresPriceStore implements PriceStore {
  private readonly sql: SQL;
  private readonly ready: Promise<void>;

  constructor(connectionString: string) {
    this.sql = new SQL(connectionString);
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS cars (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_key      text NOT NULL,
        market          text NOT NULL,
        make            text NOT NULL,
        model           text NOT NULL,
        trim            text,
        year            integer NOT NULL,
        fuel            text,
        transmission    text,
        colour          text,
        last_mileage_km integer NOT NULL,
        last_price      integer NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        last_seen_at    timestamptz NOT NULL DEFAULT now()
      )`;
    await this.sql`CREATE INDEX IF NOT EXISTS cars_bucket_key_idx ON cars (bucket_key)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS price_observations (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        car_id      uuid NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
        price       integer NOT NULL,
        mileage_km  integer NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now(),
        source_url  text NOT NULL
      )`;
    await this.sql`CREATE INDEX IF NOT EXISTS price_obs_car_id_idx ON price_observations (car_id)`;
  }

  async findCarsByBucketKey(key: string): Promise<CarRow[]> {
    await this.ready;
    const rows = (await this.sql`SELECT * FROM cars WHERE bucket_key = ${key}`) as CarDbRow[];
    return rows.map(toCarRow);
  }

  async insertCar(car: NewCar): Promise<CarRow> {
    await this.ready;
    const rows = (await this.sql`
      INSERT INTO cars
        (bucket_key, market, make, model, trim, year, fuel, transmission, colour,
         last_mileage_km, last_price, created_at, last_seen_at)
      VALUES
        (${car.bucketKey}, ${car.market}, ${car.make}, ${car.model}, ${car.trim}, ${car.year}, ${car.fuel},
         ${car.transmission}, ${car.colour}, ${car.lastMileageKm}, ${car.lastPrice},
         ${car.createdAt}, ${car.lastSeenAt})
      RETURNING *`) as CarDbRow[];
    return toCarRow(rows[0]!);
  }

  async insertObservation(
    carId: string,
    price: number,
    mileageKm: number,
    sourceUrl: string,
    observedAt: string,
  ): Promise<void> {
    await this.ready;
    await this.sql`
      INSERT INTO price_observations (car_id, price, mileage_km, observed_at, source_url)
      VALUES (${carId}, ${price}, ${mileageKm}, ${observedAt}, ${sourceUrl})`;
  }

  async updateCarOnPriceChange(
    carId: string,
    patch: { lastPrice: number; lastMileageKm: number; lastSeenAt: string },
  ): Promise<void> {
    await this.ready;
    await this.sql`
      UPDATE cars
      SET last_price = ${patch.lastPrice},
          last_mileage_km = ${patch.lastMileageKm},
          last_seen_at = ${patch.lastSeenAt}
      WHERE id = ${carId}`;
  }

  async touchCar(carId: string, lastSeenAt: string, lastMileageKm: number): Promise<void> {
    await this.ready;
    await this.sql`
      UPDATE cars SET last_seen_at = ${lastSeenAt}, last_mileage_km = ${lastMileageKm}
      WHERE id = ${carId}`;
  }

  async getObservations(carId: string): Promise<PriceObservation[]> {
    await this.ready;
    const rows = (await this.sql`
      SELECT price, mileage_km, observed_at
      FROM price_observations WHERE car_id = ${carId} ORDER BY observed_at ASC`) as {
      price: number;
      mileage_km: number;
      observed_at: string;
    }[];
    return rows.map((r) => ({
      price: r.price,
      mileageKm: r.mileage_km,
      observedAt: typeof r.observed_at === "string" ? r.observed_at : new Date(r.observed_at).toISOString(),
    }));
  }
}

/** Default tracker for the running server: Postgres when DATABASE_URL is set,
 *  otherwise a no-op so local/dev and tests run without a database. */
export function createDefaultTracker(): PriceTracker {
  const url = process.env.DATABASE_URL;
  if (!url) return noopPriceTracker;
  return new DbPriceTracker(new PostgresPriceStore(url));
}
