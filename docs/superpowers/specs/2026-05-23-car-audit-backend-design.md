# Car Audit Backend — Design (v0)

**Date:** 2026-05-23
**Status:** Built (v0)

## Purpose

A lightweight backend for a Chrome extension that acts as a car-buying copilot.
When a user browses a car listing (DoneDeal first, Autotrader and other sites
later), the extension sends a pre-entered buyer **profile** plus the **URL** of
the listing to this backend. The backend uses the Gemini API to read the listing
page and produce a concise, honest **audit** of the car relative to that profile:
is it a good fit, what are the green/red flags, and what to verify with the seller.

Core flow: `profile + listing URL → AI audit of the car`.

## Scope decision: Approach A (stateless thin proxy)

The backend is stateless. All state (the profile) lives client-side in the
extension and is sent with every request. No database, no accounts, no caching.

Gemini lives only in the backend: the extension just sends the listing URL, and
the backend reads the page (via Gemini's `urlContext` tool) and audits it. The
extension stays thin and ships no API key.

> Trade-off accepted: server-side `urlContext` re-fetches the URL fresh, so for
> bot-blocked, JS-heavy, or login-gated sites Gemini may see a thinner page than
> the user does. Confirmed working on DoneDeal; watch this as new sites are added.

## Architecture

```
Extension ──POST /audit (profile + url)──▶ Bun server
   └─▶ Gemini stage 1: read listing page (urlContext)  → listing markdown
   └─▶ Gemini stage 2: audit (no tools, JSON schema)   → Audit JSON ──▶ extension
```

- Single Bun HTTP server.
- One real endpoint (`POST /audit`) plus a `GET /health` for deploy checks.
- Stateless: no DB, no user state.
- **Two Gemini calls.** Stage 2 must run *without* tools — enabling a tool
  (urlContext) makes Gemini ignore the response schema and invent field names,
  so reading and auditing are split into separate calls.

## Endpoint

```
POST /audit
Headers:  X-API-Key: <shared key>
          Content-Type: application/json
Body:     { profile: {...}, url: "https://www.donedeal.ie/cars-for-sale/.../42108822" }
Response: application/json  (single structured Audit object — see schema below)
```

- **Auth:** a single shared `X-API-Key` (env var `AUDIT_API_KEY`), compared with
  a timing-safe equality check. This is not user auth — it only stops anonymous
  callers from draining the Gemini quota if they find the URL. The extension ships
  with the key. If unset, the server runs in unauthenticated dev mode (with a
  startup warning). See `.env.example` for the key-generation command.
- **CORS:** `ALLOWED_ORIGIN` env var (default `*`); lock to the extension origin
  once its ID is known.
- **Validation:** `url` must be a valid http(s) URL whose host is on the listing
  allow-list (`ALLOWED_LISTING_HOSTS`, default `donedeal.ie`, `autotrader.ie`,
  `autotrader.co.uk`, subdomains included; `*` allows any host); `profile` must be
  an object.
- **Rate limit:** per-IP fixed-window limiter (`RATE_LIMIT_PER_DAY`, default 25;
  `RATE_LIMIT_WINDOW_MS`, default 24h; `0` disables). Checked after validation and
  before the Gemini calls, so only valid, allowed-host audit attempts count
  (including cache hits). Over-limit requests get `429` with `Retry-After` and
  `X-RateLimit-*` headers. Behind a proxy, set `TRUST_PROXY` so the client IP is
  read from `X-Forwarded-For` rather than the shared proxy socket IP.

## Profile schema

All fields optional; the extension sends whatever the user filled in.

```ts
interface Profile {
  budgetMax?: number          // €
  financePerMonthMax?: number // €
  use?: string                // "commuting" | "family" | "performance" | free text
  preferredMakes?: string[]
  maxMileageKm?: number
  minYear?: number
  transmission?: "automatic" | "manual" | "any"
  fuel?: "petrol" | "diesel" | "hybrid" | "ev" | "any"
  mustHaves?: string[]        // ["Apple CarPlay", "heated seats"]
  dealBreakers?: string[]     // ["cat write-off", "timing belt due"]
  notes?: string              // free-text priorities
}
```

## Audit output

A single **structured JSON** object, generated via Gemini's JSON mode — not
streamed. The response UI is animated and dynamic (a score gauge, quick fit
chips, and AI insight sections), so it needs typed fields rather than prose.

**Value principle:** the buyer can already read the listing, so the audit does
not restate it. Visible facts are condensed into quick chips; the substance is
what the buyer *can't* easily see — condition/hidden risks, model-year
particulars, and better-fit alternatives.

```ts
type Verdict = "good_fit" | "proceed_with_caution" | "avoid"

interface FitChip {                 // quick 2–4 word profile flashes
  label: string                     // "Petrol, wanted diesel" · "€50 under budget"
  status: "match" | "mismatch" | "neutral"
}
interface Insight { title: string; detail: string }
interface Alternative {
  car: string                       // "BMW 320d M Sport (G20, 2021+)" · "Audi A4 40 TDI"
  sameModelNewerYear: boolean       // true = better year of the same car; false = different car
  reason: string                    // why it fits the profile better
}

interface Audit {
  verdict: Verdict                  // gauge label
  score: number                     // 0–100, gauge needle
  summary: string                   // bottom line
  fitChips: FitChip[]               // quick profile match/mismatch flashes (visible facts)
  listingSnapshot: string           // ONE short sentence recapping the listed facts
  assessment: Insight[]             // ★ hidden issues / non-obvious concerns not on the listing
  modelYearNotes: Insight[]         // ★ what's particular about this model / generation / year
  alternatives: Alternative[]       // ★ better year of same car, and/or similar better-fit cars
}
```

- **Alternatives are AI-suggested** (from Gemini's car knowledge), not live
  listings. A search-grounded version (real current listings) is a future step
  that would need an extra search stage.
- UI mapping: `score` + `verdict` → gauge; `fitChips` → coloured chip row;
  `listingSnapshot` → one muted line; `assessment` / `modelYearNotes` /
  `alternatives` → the three primary insight sections (`sameModelNewerYear` tags
  "newer year" vs "different car").

## Gemini call

- SDK: `@google/genai` (already a dependency). Model: **`gemini-3.5-flash`**.
- **Stage 1 (read):** `generateContent` with `tools: [{ urlContext: {} }]`,
  temperature 0, extraction system prompt → listing markdown (plain text out).
- **Stage 2 (audit):** `generateContent` with **no tools**, temperature 0.2,
  `responseMimeType: "application/json"` + `responseJsonSchema: AUDIT_SCHEMA`
  → strict `Audit` JSON.
  - SDK note: `@google/genai@2.6.0` uses `responseMimeType` + `responseSchema` /
    `responseJsonSchema` (a raw JSON Schema goes in `responseJsonSchema`). It does
    **not** accept `responseFormat` (that field is newer than this SDK version).
  - Output is run through a code-fence stripper before `JSON.parse` (the model
    occasionally wraps JSON in ```` ```json ````), then validated against the
    `Audit` shape; invalid output → `AuditError`.
- **Irish-market-aware, expert** audit system prompt: understands NCT, VRT,
  annual road tax, '192'-style registration years, owner/history conventions,
  dealer vs private. Focuses on non-obvious insight (condition risks, model-year
  particulars, alternatives) rather than restating the listing, and recommends a
  paid history check within `assessment` when warranted (UK import, VRT-pending,
  0-owner with pending history).

## Caching

- In-memory TTL cache (`src/cache.ts`, `TtlCache`) keyed by `(profile, url)` via
  `auditCacheKey` (profile keys sorted for stability). `runAuditCached` wraps the
  pure `runAudit`: a cache hit skips both Gemini calls.
- TTL default 1 hour (`CACHE_TTL_MS`), max 500 entries (evict oldest). Short TTL
  because listings change (price drops, sold).
- Process-local: a single instance shares it; multiple instances do not. A shared
  store (e.g. Redis) is a future step if the backend scales horizontally.

## Files

- `src/server.ts` — Bun server, routing, timing-safe auth, validation, CORS
- `src/audit.ts` — two-stage Gemini flow (`runAudit`) + cached wrapper
  (`runAuditCached`), fence-strip + `isAudit` validation, `AuditError`
- `src/prompt.ts` — extraction + audit system prompts, profile/message formatting,
  `AUDIT_SCHEMA`
- `src/cache.ts` — `TtlCache` + `auditCacheKey`
- `src/ratelimit.ts` — `DailyRateLimiter` (per-IP fixed-window request limiter)
- `src/types.ts` — `Profile`, `AuditRequest`, `Audit` (and `Flag` / `WatchItem`) types
- `.env.example` — documents `GEMINI_API_KEY`, `AUDIT_API_KEY`, and optional vars

## Error handling

- `400` — missing/invalid `url` (must be http(s)), disallowed listing host, or
  non-object `profile`
- `401` — missing or wrong `X-API-Key` (when `AUDIT_API_KEY` is set)
- `429` — per-IP daily request limit reached (with `Retry-After` header)
- `502` — Gemini call failure, empty/non-JSON output, or schema-invalid output;
  returned as a JSON error body
- Per-stage timeout guard (45s read, 30s audit)

## Testing (`bun test`)

- Prompt builders produce the expected output from a sample profile + listing/URL.
- Request validation rejects bad bodies (missing/invalid url, wrong types).
- Two-stage flow: stage 1 uses the urlContext tool, stage 2 uses the enforced
  schema with no tools; mocked Gemini responses flow end-to-end to the HTTP layer.
- Fenced JSON is parsed; empty / non-JSON / schema-invalid output → `AuditError` → `502`.

## Out of scope (YAGNI for v0)

- No database, no profile storage, no accounts.
- No shared/persistent cache (the in-memory cache above is process-local).
- Rate limiting and the host allow-list are process-local too — limits are
  enforced per instance, so horizontal scaling needs a shared store (e.g. Redis)
  to enforce a global per-IP limit.
- No multi-site adapters yet — the URL-in contract keeps it site-agnostic, but the
  allow-list restricts hosts to the supported listing sites (extend via
  `ALLOWED_LISTING_HOSTS`), subject to the urlContext trade-off above.
