# Car Price Tracking — Design (v1)

**Date:** 2026-05-24
**Status:** Built (v1) — logic unit-tested; the live Postgres path needs a smoke test against a real database
**Builds on:** [2026-05-23-car-audit-backend-design.md](./2026-05-23-car-audit-backend-design.md)

## Purpose

Track how a **car's** asking price changes over time — not a *listing's*. Dealers
routinely take a car down and relist it under a new URL, so a listing-keyed
history loses the thread the moment that happens. We want price history that
follows the physical car across relists.

This rides entirely on the existing audit flow: every time someone audits a
listing, we fingerprint the car, match it against a shared registry, and record a
price point. Price history is a **byproduct of audit traffic** — no crawlers, no
background jobs, no per-user state.

Core flow addition: `fresh audit → fingerprint car → match/append price point → return history`.

## Scope decision: passive, shared, fingerprint-matched

- **Passive discovery.** A car's price is only re-observed when *some* user audits
  a listing for it. We never crawl or actively hunt relists. Coverage equals the
  set of cars people actually look at; a relist surfaces the instant someone opens
  it.
- **Shared registry, not per-user.** The backend stays stateless about *users*.
  Observations are recorded against the car, anonymously. There is no watchlist
  and no per-user history.
- **Fuzzy spec fingerprint for identity.** No images, no registration-plate OCR.
  Identity is derived from the structured vehicle fields the audit already
  extracts.

These keep v1 small and avoid new infrastructure beyond a database.

## Identity & matching

The hard problem is deciding whether a listing is the *same physical car* as one
seen before. Mileage moves (it only climbs) and `make+model+year+mileage` is not
unique, so naive matching both **falsely merges** distinct cars (→ a fake price
history) and **misses** real relists. We bias toward **precision over recall: a
wrong merge is worse than no history.**

**Bucket key (must match exactly after normalization):**
`make · model · year · fuel · transmission`

Normalization: lowercase, trim, collapse whitespace, strip non-alphanumerics.
Fuel and transmission are low-cardinality enums, so they're safe in the key. Trim
is *not* in the key (its free-text wording varies between listings and would
fragment the same car).

**Candidate match within a bucket** — a stored car matches the new observation when:

- **Mileage is compatible (directional, since mileage only rises):**
  `stored_mileage − 2,000 ≤ new_mileage ≤ stored_mileage + max(8,000, 10% of stored_mileage)`
  (the −2,000 absorbs data-entry noise; the upper band absorbs driving between
  relists). Tunable constants.
- **Trim agrees or is blank on either side** (tiebreaker, not required).
- **Colour agrees or is blank on either side** (tiebreaker, not required).

**Resolution (precision-first):**

- **0 candidates** → create a new car.
- **exactly 1 candidate** → that's the car.
- **>1 candidate** → ambiguous → create a new car (do **not** merge).

**Required fields to track at all:** `make`, `model`, `year`, `mileageKm`,
`priceEur`. If any are missing (e.g. a "POA" listing with no price, or an
unparseable page), we **skip tracking** for that audit — the audit itself still
returns normally.

Known, accepted limitations (documented, not bugs): two genuinely identical cars
at the same dealer collapse into one history; a car driven a long way between
relists or with a mis-typed mileage may start a fresh identity; ambiguous buckets
fragment. These are the cost of avoiding false merges without images or a plate.

## Data source — no new Gemini call

Stage 2 of the audit already runs with no tools and an enforced JSON schema. We
extend that schema (and the system prompt) to also emit a normalized vehicle block
and the price, so a single existing call yields both the audit and the fingerprint:

```ts
vehicle: {
  make: string
  model: string
  trim?: string
  year: number
  mileageKm?: number
  fuel?: "petrol" | "diesel" | "hybrid" | "ev" | string
  transmission?: "automatic" | "manual" | string
  colour?: string
}
priceEur?: number   // null/absent for POA / finance-only listings
```

Stage 1 stays markdown-only (it uses the `urlContext` tool, which can't be
combined with a response schema — see the audit design doc).

## Storage — Railway Postgres (Bun's built-in SQL)

A managed Postgres database, added as a one-click service in the same Railway
project. Railway injects the connection string as `DATABASE_URL` (a reference
variable) into the backend service. Bun ships built-in SQL with Postgres support
(`Bun.sql`), so there is **no driver to install** — it stays as dependency-light
as the rest of the project. The schema is created on startup with
`CREATE TABLE IF NOT EXISTS` (no migration tooling needed for v1).

**Why this over SQLite-on-a-volume:** the Postgres service persists independently
of app redeploys (no ephemeral-filesystem footgun) and is shared, so the design is
**not** pinned to a single replica. The tracker still sits behind an interface, so
the store can be swapped later without touching the matching logic.

Two tables.

**`cars`** — one row per resolved identity:

| column           | type        | notes                                            |
|------------------|-------------|--------------------------------------------------|
| `id`             | uuid pk     | default `gen_random_uuid()`                      |
| `bucket_key`     | text        | normalized `make·model·year·fuel·transmission`; indexed |
| `make`           | text        |                                                  |
| `model`          | text        |                                                  |
| `trim`           | text null   |                                                  |
| `year`           | integer     |                                                  |
| `fuel`           | text null   |                                                  |
| `transmission`   | text null   |                                                  |
| `colour`         | text null   |                                                  |
| `last_mileage_km`| integer     | highest mileage seen; used for tolerance matching |
| `last_price_eur` | integer     | denormalized for the change comparison            |
| `created_at`     | timestamptz | default `now()`                                  |
| `last_seen_at`   | timestamptz |                                                  |

**`price_observations`** — one row per *price point* (not per view):

| column        | type        | notes                          |
|---------------|-------------|--------------------------------|
| `id`          | uuid pk     | default `gen_random_uuid()`    |
| `car_id`      | uuid        | → `cars.id`, indexed           |
| `price_eur`   | integer     |                                |
| `mileage_km`  | integer     | mileage at this observation    |
| `observed_at` | timestamptz | default `now()`                |
| `source_url`  | text        | the listing URL seen this time |

The observations are the source of truth for history; `cars.last_price_eur` /
`last_mileage_km` / `last_seen_at` are denormalized only to make the per-audit
comparison a single lookup.

## Flow

Recording happens **only on a fresh audit (cache miss)**. Cache hits return the
history snapshot computed when the entry was cached — within the 1h TTL the price
won't have moved, so re-recording would only add duplicate noise.

On a cache miss, after the audit is produced:

1. Read the `vehicle` block + `priceEur` from the audit. If required fields are
   missing → skip (return audit with no `priceHistory`).
2. Compute `bucket_key`; load candidate cars for that key.
3. Apply the candidate match rule → resolve to an existing car or decide to create
   one (per precision-first resolution above).
4. **Write the price point:**
   - *New car* → insert `cars` row + first `price_observations` row.
   - *Existing car, price differs from `last_price_eur`* → insert a new
     observation; update `last_price_eur`, `last_seen_at`, and bump
     `last_mileage_km` if higher.
   - *Existing car, price unchanged* → no observation row; update `last_seen_at`
     (and `last_mileage_km` if higher).
5. Read the car's observations back, build `priceHistory`, attach it to the audit
   response (and to the cached copy).

"Whether the price changed" is **derived** from the observation series at read
time, never stored as a flag.

## Response shape

`Audit` gains an optional `priceHistory` field (absent when tracking was skipped
or disabled):

```ts
interface PriceObservation {
  priceEur: number
  mileageKm: number
  observedAt: string        // ISO timestamp
}

interface PriceHistory {
  carId: string
  observations: PriceObservation[]   // oldest → newest
  firstSeenAt: string
  lastSeenAt: string
  currentPriceEur: number
  changeSinceFirstEur: number        // currentPrice − firstObservedPrice (signed)
  lastChange?: {                     // most recent price move, if any
    deltaEur: number                 // signed
    fromPriceEur: number
    observedAt: string
  }
}
```

The extension renders this inline ("↓ €1,000 since 12 Apr — previously listed under
a different ad").

## Error handling

Price tracking is **best-effort and non-blocking**. Any failure in the tracking
path (Postgres unreachable, write error, missing fields) is logged and swallowed
*for tracking only* — the audit response is returned normally with `priceHistory`
omitted. A tracking failure must never turn a successful audit into an error.

If `DATABASE_URL` is unset, the tracker is a **no-op** (returns no history), so
local/dev runs and the existing test suite work without a database.

## Files

- `src/pricetracker.ts` — `PriceTracker` interface, fingerprint normalization +
  matching logic, `PostgresPriceTracker` implementation (via `Bun.sql`),
  `PriceHistory` / `PriceObservation` types, and the `CREATE TABLE IF NOT EXISTS`
  schema bootstrap. Pure matching functions are exported for unit testing.
- `src/audit.ts` — extend `isAudit` to validate the new `vehicle` / `priceEur`
  fields; wire an injectable `tracker` into `runAuditCached` (invoked only on the
  miss path; result attached before caching).
- `src/prompt.ts` — extend `AUDIT_SCHEMA` and the audit system prompt to emit the
  `vehicle` block and `priceEur`.
- `src/types.ts` — add `vehicle` + `priceEur` to the audit data and
  `PriceHistory` to `Audit`.
- `.env.example` — `DATABASE_URL`.

The server (`src/server.ts`) is unchanged: it calls `runAuditCached` as today and
passes the enriched audit through.

## Config

- `DATABASE_URL` — Postgres connection string (auto-injected by Railway as a
  reference variable from the Postgres service). Unset → tracking disabled (no-op).
- Matching tolerances (`±` mileage constants) are code constants in v1; promote to
  env later if they need tuning in production.

## Testing (`bun test`)

- **Matching logic** (pure functions, no DB): exact relist recognized; mileage
  within/over tolerance; same bucket + different mileage stays separate; ambiguous
  bucket (>1 candidate) creates new rather than merging; missing required fields →
  skip; trim/colour as tiebreakers.
- **Tracker** against an in-memory fake store: first sighting inserts; unchanged
  price bumps `last_seen_at` without a new row; changed price inserts a point;
  `priceHistory` derived fields (`changeSinceFirstEur`, `lastChange`) computed
  correctly.
- **End-to-end** through `runAuditCached` with a stub tracker: history attaches on
  miss, served from cache on hit, and a tracker error never fails the audit.
- **Schema**: stage-2 output with the new `vehicle` / `priceEur` fields validates;
  absent `priceEur` is accepted.

## Out of scope (v1)

- No watchlist, no alerts/notifications (these need active discovery, ruled out).
- No crawling or active relist re-hunting.
- No image hashing or registration-plate OCR.
- No per-user history or accounts.
- No cross-currency handling (Irish market = EUR).
