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
}

export type Verdict = "good_fit" | "proceed_with_caution" | "avoid";
export type Severity = "low" | "medium" | "high";

export interface Flag {
  title: string; // short chip label, e.g. "Within budget"
  detail: string; // one-sentence explanation
  severity?: Severity; // red flags only — drives colour intensity
}

export interface WatchItem {
  title: string;
  detail: string;
  suggestHistoryCheck?: boolean; // mark items worth a paid Cartell/Motorcheck report
}

/** Structured audit returned to the extension. */
export interface Audit {
  verdict: Verdict; // category for the gauge label
  score: number; // 0–100, drives the gauge needle
  summary: string; // 1–2 sentence bottom line
  greenFlags: Flag[]; // render green
  redFlags: Flag[]; // render red, shaded by severity
  watchFor: WatchItem[]; // "ask the seller / verify" items
}
