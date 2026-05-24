// Shared types for the car-audit backend.
// See docs/superpowers/specs/2026-05-23-car-audit-backend-design.md

/** Buyer profile, entered in the extension and sent with every request. All fields optional. */
export interface Profile {
  budgetMax?: number; // €
  financePerMonthMax?: number; // €
  use?: string; // "commuting" | "family" | "performance" | free text
  preferredMakes?: string[];
  maxMileageKm?: number;
  minYear?: number;
  transmission?: "automatic" | "manual" | "any";
  fuel?: "petrol" | "diesel" | "hybrid" | "ev" | "any";
  mustHaves?: string[]; // ["Apple CarPlay", "heated seats"]
  dealBreakers?: string[]; // ["cat write-off", "timing belt due"]
  notes?: string; // free-text priorities
}

/** Request body for POST /audit. */
export interface AuditRequest {
  profile: Profile;
  url: string; // URL of the listing page; the backend reads it via Gemini (urlContext)
  listingText?: string; // pre-extracted page content from the client's browser; when present the backend skips its own fetch
}

export type Verdict = "good_fit" | "proceed_with_caution" | "avoid";

/** Listing market: "uk" (GBP, miles — incl. Northern Ireland) or "ie" (EUR, km). */
export type Market = "uk" | "ie";

/** A quick 2–3 word profile-fit flash, e.g. "Petrol, wanted diesel". */
export interface FitChip {
  label: string;
  status: "match" | "mismatch" | "neutral";
}

/** A short headline + explanation for an AI insight. */
export interface Insight {
  title: string;
  detail: string;
}

/** A suggested better-fit car (AI-suggested, not a live listing). */
export interface Alternative {
  car: string; // e.g. "BMW 320d M Sport (G20, 2021+)" or "Audi A4 40 TDI"
  sameModelNewerYear: boolean; // true = better year of the same car; false = a different car
  reason: string; // why it fits the profile better
}

/** Normalized car facts extracted alongside the audit, used to fingerprint the
 *  car for price tracking across relists. See the price-tracking design doc. */
export interface Vehicle {
  make: string;
  model: string;
  trim?: string;
  year: number;
  mileageKm?: number;
  fuel?: string;
  transmission?: string;
  colour?: string;
}

/** A single price point for a car (one row per price change, not per view).
 *  Price is in the car's native currency — see {@link PriceHistory.market}. */
export interface PriceObservation {
  price: number;
  mileageKm: number;
  observedAt: string; // ISO timestamp
}

/** A car's price history across every listing we've seen it in. All prices are
 *  in the car's native currency, indicated by `market` (uk = GBP, ie = EUR). */
export interface PriceHistory {
  carId: string;
  market: Market; // currency context for every price below
  observations: PriceObservation[]; // oldest → newest
  firstSeenAt: string;
  lastSeenAt: string;
  currentPrice: number;
  changeSinceFirst: number; // currentPrice − firstObservedPrice (signed)
  lastChange?: {
    delta: number; // signed
    fromPrice: number;
    observedAt: string;
  };
}

/**
 * Structured audit returned to the extension. The value is in what the buyer
 * CAN'T easily see: condition/hidden issues, model-year particulars, and
 * better-fit alternatives. Visible listing facts are condensed into quick chips.
 */
export interface Audit {
  verdict: Verdict; // category for the gauge label
  market: Market; // "uk" (GBP, miles; incl. Northern Ireland) or "ie" (EUR, km) — sets the currency for `price`
  score: number; // 0–100, drives the gauge needle
  summary: string; // 1–2 sentence bottom line
  fitChips: FitChip[]; // quick profile match/mismatch flashes
  listingSnapshot: string; // brief recap of what's in the listing (kept short)
  assessment: Insight[]; // hidden issues / non-obvious concerns not visible on the listing
  modelYearNotes: Insight[]; // what's particular about this model / generation / year
  alternatives: Alternative[]; // better year of the same car, and/or similar better-fit cars
  vehicle?: Vehicle; // normalized car facts, for price tracking across relists
  price?: number | null; // asking price in the market's native currency (GBP for uk, EUR for ie); null/absent for POA / finance-only
  priceHistory?: PriceHistory; // cross-listing price history (present only when tracking is enabled)
}
