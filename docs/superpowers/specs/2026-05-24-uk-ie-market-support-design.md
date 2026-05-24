# UK + Ireland market support (client-supplied listing text, currency & mileage)

Date: 2026-05-24
Status: Approved design — pending spec review

## Problem

Two related gaps:

1. **AutoTrader UK can't be read server-side.** Stage 1 (`extractListing`) fetches the
   listing via Gemini's `urlContext` tool, which runs from Google's infrastructure.
   AutoTrader UK sits behind Cloudflare anti-bot protection, so that fetch receives a
   challenge page instead of the listing → the model reports the page as unreadable.
   DoneDeal and AutoTrader.ie are unaffected.

2. **The data model is EUR/km-only.** `priceEur` and `mileageKm` assume the Irish
   market. UK listings (incl. Northern Ireland) are priced in GBP and quote mileage in
   miles, so a UK listing would write GBP into a field named "Eur" and risk mixing units —
   corrupting the price-tracking history the feature exists to provide.

A console test confirmed the user's browser, already past Cloudflare, captures the full
listing (make/model/year/price/mileage/spec/description). So the fix is to let the client
supply that text, and to teach the model + tracker about both markets.

## Goals

- Accept listing content from the client and skip the server-side fetch when present.
- Support both the **Irish market** (`ie`: EUR, km) and the **UK market** (`uk`: GBP,
  miles — Northern Ireland is `uk`).
- Keep price-history tracking correct across markets (never compare a UK car to an Irish
  one as if they were the same listing).

## Non-goals

- No currency (FX) conversion. Prices are stored in their native currency; we never invent
  an exchange rate.
- No headless browser, scraping API, or anti-bot circumvention on the server.
- No change to the client/extension code (out of this repo). This spec covers the backend
  contract + the local test console only.
- No general migration tooling. The price-tracking tables are brand new (commit `a9c042b`),
  so we adjust their definitions directly rather than build migrations.

## Design

### 1. Request: optional `listingText`

`AuditRequest` gains an optional field:

```ts
interface AuditRequest {
  profile: Profile;
  url: string;
  listingText?: string; // pre-extracted listing content from the client's browser
}
```

- When `listingText` is present and non-empty, `runAudit` **skips `extractListing`** and
  passes the text straight to stage 2 (`auditListing`).
- When absent, behaviour is unchanged: stage 1 fetches via `urlContext` (DoneDeal /
  AutoTrader.ie keep working URL-only).
- `url` remains **required** — still used for the host allow-list, the cache key, and
  `source_url` on price observations.
- Validation (`server.ts`): if present, `listingText` must be a string; reject with 400 if
  it exceeds a length cap of **100,000 characters** (guards against oversized bodies).
- Cache key stays `(profile, url)`. `listingText` does not enter the key — identical
  `(profile, url)` within the TTL returns the cached audit regardless of supplied text,
  matching today's URL-based semantics.

### 2. Response: `market` + native `price`

`Audit` changes:

- **Add** `market: "uk" | "ie"` (required). The model infers it from the listing's currency
  and units: `£` / "miles" → `uk`; `€` / "km" → `ie`. Northern Ireland → `uk`. If genuinely
  undeterminable, default to `ie`.
- **Rename** `priceEur?: number | null` → `price?: number | null`. The value is the asking
  price in the listing's native currency; `market` tells the consumer which (`uk`=GBP,
  `ie`=EUR). Currency is **derived** from `market`, not stored as a separate field.
- `mileageKm` is **unchanged** and remains km. The prompt instructs the model to convert UK
  miles → km (× 1.609). This keeps the field honest and leaves the tracker's km-based match
  tolerances valid.

`Vehicle` is unchanged (`mileageKm` stays km).

### 3. Prompt changes (`prompt.ts`)

- `SYSTEM_PROMPT`: add a market block — determine `market` from currency symbol and mileage
  units; report `price` in native currency (omit for POA); always express `mileageKm` in km,
  converting from miles for UK listings.
- `AUDIT_SCHEMA`:
  - rename `priceEur` → `price` (same description, native currency).
  - add `market` with `enum: ["uk", "ie"]`.
  - add `market` to the top-level `required` array.

### 4. Runtime validation (`audit.ts`)

- `isAudit`: require `market` to be one of `["uk", "ie"]`; validate `price` (number | null |
  absent) under its new name. Everything else unchanged.

### 5. Price tracking (`pricetracker.ts`)

- `Fingerprint` gains `market: "uk" | "ie"`.
- `extractFingerprint`: read `audit.price` (was `priceEur`) and `audit.market`; return null
  if any required field is missing, as today.
- `bucketKey(vehicle, market)`: **include `market`** as the first segment so a UK and an
  Irish car of the same make/model/year never share a bucket.
- `NewCar` / `CarRow`: rename `lastPriceEur` → `lastPrice`; add `market: "uk" | "ie"`.
- `PriceObservation` (types): rename `priceEur` → `price`.
- `PriceHistory` (types): rename `currentPriceEur` → `currentPrice`,
  `changeSinceFirstEur` → `changeSinceFirst`, `lastChange.fromPriceEur` → `fromPrice`,
  `lastChange.deltaEur` → `delta`; add `market` so the consumer knows the currency.
- `DbPriceTracker.record` / `buildPriceHistory`: thread `market` through; use renamed fields.
- `InMemoryPriceStore`: rename `lastPriceEur` → `lastPrice`; carry `market`.
- Mileage match tolerances (`MILEAGE_NOISE_KM`, `MILEAGE_TOLERANCE_KM`,
  `MILEAGE_TOLERANCE_FRAC`) are **unchanged** — mileage is canonical km for both markets.

### 6. Database (`PostgresPriceStore`)

Table definition changes (applied to the `CREATE TABLE` statements):

- `cars`: rename column `last_price_eur` → `last_price`; add `market text NOT NULL`.
- `price_observations`: rename column `price_eur` → `price`.

Because there is no migration tooling and the tables are brand new with no production data
worth keeping, the rollout is **drop and recreate** the `cars` and `price_observations`
tables (documented below). `toCarRow` and `getObservations` map the renamed columns and
`market`.

## Data flow

```
client browser (past Cloudflare)
  → POST /audit { profile, url, listingText? }
    → validateBody (cap listingText at 100k chars)
      → runAuditCached(profile, url, { listingText })
        → cache hit? return
        → runAudit:
            stage 1: listingText present → use it ; else urlContext fetch
            stage 2: audit → { ..., market, price, vehicle{ mileageKm } }
        → tracker.record(audit, url):
            fingerprint = { vehicle, mileageKm, price, market }
            bucketKey(vehicle, market)  // market-scoped
            insert/match/observe ; attach priceHistory (with market)
        → cache.set ; return
```

## Testing

- **audit.test**: `listingText` present → `extractListing` (urlContext) not called, stage 2
  receives the supplied text; `isAudit` accepts valid `market`, rejects bad/missing `market`;
  `price` validated under new name.
- **pricetracker.test**: `bucketKey` differs by market for otherwise-identical cars; a UK and
  an IE car never merge; fingerprint carries `market` and `price`; history uses renamed fields
  and includes `market`.
- **server.test**: `listingText` over the cap → 400; valid `listingText` threaded into
  `runAudit`.
- **prompt.test**: schema exposes `price` and `market` (enum), `market` is required.

## Affected files

- `src/types.ts` — `AuditRequest.listingText`; `Audit.market` + `price` rename;
  `PriceObservation`/`PriceHistory` renames.
- `src/prompt.ts` — system prompt market/units rules; `AUDIT_SCHEMA` `price`/`market`.
- `src/audit.ts` — thread `listingText`, skip fetch; `isAudit` market/price.
- `src/server.ts` — validate + thread `listingText`.
- `src/pricetracker.ts` — fingerprint/bucket/store/history market + renames; Postgres schema.
- `public/index.html` — optional "paste listing text" textarea for manual testing; update
  `priceBlock` to the renamed fields and format currency by `market` (£ vs €).
- Tests for each of the above.

## Rollout

1. Land code + tests.
2. On the Railway Postgres (no data worth keeping): `DROP TABLE price_observations, cars;`
   — recreated on next boot via `bootstrap()`.
3. Client/extension change (separate repo) to send `listingText`; UK listings then audit and
   track correctly.

## Open risks

- Model mis-detecting `market` on an ambiguous listing → defaults to `ie`. Acceptable; can
  add an explicit override later if needed.
- Model mileage conversion (miles→km) is approximate, but match tolerances (≥ 8,000 km or
  10%) absorb rounding comfortably.
