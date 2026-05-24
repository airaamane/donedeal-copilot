// System prompt, user-message formatting, and the response JSON schema
// for the car audit. Kept dependency-free: the schema is hand-written
// JSON Schema (the @google/genai `schema` field accepts this directly).

import type { Profile } from "./types.ts";

// --- Stage 1: read the listing page into clean markdown (uses urlContext) ----

export const EXTRACTION_SYSTEM_PROMPT = `You read a car listing web page and extract its content as clean, structured markdown.

Include every concrete detail present: price and finance, make/model/trim, year and registration, mileage, engine and fuel, transmission, drive type, body type, colour, features/equipment, NCT, annual road tax, VRT/registration/import notes, owner count, and seller/dealer info plus any history notes.

Do not add opinions, ratings, or information that is not on the page. If the page cannot be read or is not a car listing, say so plainly in one line.`;

export function buildExtractionMessage(url: string): string {
  return `Read this car listing and extract its details as markdown:\n${url.trim()}`;
}

// --- Stage 2: audit the extracted listing against the profile (enforced schema) -

export const SYSTEM_PROMPT = `You are an expert car-buying copilot for the Irish used-car market (DoneDeal, dealers, and private sellers).

You receive a buyer PROFILE and a LISTING (markdown extracted from the listing page).

The buyer can already READ the listing — so do not just restate its facts. Your value is telling them what they CANNOT easily see: condition/hidden risks, what's particular about this exact model/generation/year, and whether a different year or a different car would suit them better.

Produce:
- fitChips: quick 2–3 word flashes comparing the car to the profile. Use these for the visible facts the buyer can check themselves — short labels like "Petrol, wanted diesel", "€50 under budget", "118k km — high", "Auto ✓". status is "match" (fits the profile), "mismatch" (conflicts), or "neutral" (notable but neither). Keep each label ≤ ~4 words. Omit chips for profile fields the buyer left blank.
- listingSnapshot: ONE short sentence recapping the key listed facts (make/model/year/price/mileage/spec). Brief — the buyer can read the rest.
- assessment: the core value. Non-obvious things an expert would flag that are NOT spelled out in the listing: likely condition risks, what the listing's wording implies (e.g. VRT-pending import ⇒ no Irish history; "0 owners" is a placeholder), high-mileage-diesel concerns (DPF, timing chain, injectors), spec-specific caveats (M Sport on 19s ⇒ kerbed alloys/firm ride), pricing sense for the market, and whether a paid history check (Cartell/Motorcheck) is worth it and why. Base this on general automotive knowledge; hedge honestly ("commonly reported", "worth verifying") rather than asserting faults you can't confirm.
- modelYearNotes: what's particular about THIS model/generation/engine/year — known common faults, reliability, facelift (LCI) differences, engine codes, what changed across nearby years. Concrete and specific to the car in the listing.
- alternatives: AI-suggested better fits (not live listings). Set sameModelNewerYear=true for a better year/generation of the SAME car (e.g. the LCI facelift), false for a different car. Tie each reason to the profile. If the car is a poor fit (low score), prioritise this with 2–3 genuinely better options. If it's a strong fit, one "even better" option or none is fine.

verdict: "good_fit" (~70+), "proceed_with_caution" (~40–69), "avoid" (<40). score 0–100 for fit + soundness for THIS buyer.

Irish-market context to apply: NCT, VRT (a "VRT'd on your plate"/"VRT pending" car is a UK/NI import not yet registered here — no Irish history/owners/NCT record yet), '192'-style reg years, annual road tax by CO2/engine, and that many used cars are UK imports.

If the LISTING indicates the page could not be read or is not a car listing, return verdict "proceed_with_caution", a low score, empty alternatives, and a single assessment item explaining that the listing could not be read.

Irish-market context you must apply:
- NCT (National Car Test): a fresh/long NCT is a plus; check it's genuine, not a selling gimmick.
- VRT (Vehicle Registration Tax): "VRT'd on your plate" / "VRT pending" means the car is a UK/NI import not yet registered here — there is no Irish history, owner count, or local NCT record yet. Treat "0 owners" on such cars as "history pending", not as genuinely one-owner.
- Registration year format: "192" = 2019 second-half, "201" = 2020 first-half, etc.
- Annual road tax (motor tax) varies by CO2/engine; flag if it looks high for the buyer's use.
- Diesel: high motorway mileage is normal/healthy; very low mileage urban diesels risk DPF issues.
- Imports: large share of Irish used cars are UK imports — confirm provenance and that UK mileage matches.

Honesty rules:
- Be sober and specific, not a salesperson. Tie every flag back to the profile or to a concrete listing detail.
- You only see the public listing — you cannot verify mileage, write-off status, or outstanding finance. When listing signals warrant it (UK import, VRT-pending, "0 owners" with pending history, suspiciously low price, mileage inconsistencies), set suggestHistoryCheck=true on the relevant watch item and recommend a paid history report (Cartell/Motorcheck).
- score is 0–100 for fit + soundness for THIS buyer. verdict: "good_fit" (~70+), "proceed_with_caution" (~40–69), "avoid" (<40).
- Keep titles to a few words (chip-sized). Keep details to one sentence.
- If the profile is sparse, audit the car on general merit and say what profile info would sharpen the verdict.

Also extract a normalized \`vehicle\` block (make, model, trim, year, mileageKm in km, fuel, transmission, colour) and \`priceEur\` (the asking price as a plain number in euros). These are used to track the car's price over time across relistings, so be consistent: lowercase-friendly values, mileage in km, year as the model/registration year. Omit \`priceEur\` entirely for POA / finance-only listings, and omit any vehicle field you can't determine.`;

/** Render a profile into a compact, readable block for the prompt. Omits empty fields. */
export function formatProfile(profile: Profile): string {
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      lines.push(`- ${label}: ${value.join(", ")}`);
    } else if (typeof value === "string" && value.trim() === "") {
      return;
    } else {
      lines.push(`- ${label}: ${value}`);
    }
  };

  add("Max budget (€)", profile.budgetMax);
  add("Max finance per month (€)", profile.financePerMonthMax);
  add("Intended use", profile.use);
  add("Preferred makes", profile.preferredMakes);
  add("Max mileage (km)", profile.maxMileageKm);
  add("Earliest year", profile.minYear);
  add("Transmission", profile.transmission);
  add("Fuel", profile.fuel);
  add("Must-haves", profile.mustHaves);
  add("Deal-breakers", profile.dealBreakers);
  add("Other notes", profile.notes);

  return lines.length > 0 ? lines.join("\n") : "(no profile details provided)";
}

/** Build the audit message combining the profile and the extracted listing markdown. */
export function buildAuditMessage(profile: Profile, listing: string): string {
  return `BUYER PROFILE:
${formatProfile(profile)}

LISTING:
${listing.trim()}

Audit this car for this buyer. Respond with the structured audit only.`;
}

const insightItems = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short headline (a few words)." },
    detail: { type: "string", description: "One to two sentences." },
  },
  required: ["title", "detail"],
} as const;

/** JSON Schema for the Audit response. Passed to config.responseJsonSchema. */
export const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["good_fit", "proceed_with_caution", "avoid"],
      description: "Overall verdict category for the gauge label.",
    },
    score: {
      type: "number",
      description: "0–100 fit + soundness score for this buyer; drives the gauge.",
    },
    summary: {
      type: "string",
      description: "One to two sentence bottom line.",
    },
    fitChips: {
      type: "array",
      description: "Quick 2–4 word profile-fit flashes for the visible listing facts.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "≤ ~4 words, e.g. 'Petrol, wanted diesel'." },
          status: {
            type: "string",
            enum: ["match", "mismatch", "neutral"],
            description: "Whether the fact fits the profile.",
          },
        },
        required: ["label", "status"],
      },
    },
    listingSnapshot: {
      type: "string",
      description: "One short sentence recapping the key listed facts.",
    },
    assessment: {
      type: "array",
      description: "Hidden issues / non-obvious concerns not visible on the listing.",
      items: insightItems,
    },
    modelYearNotes: {
      type: "array",
      description: "What's particular about this model / generation / engine / year.",
      items: insightItems,
    },
    alternatives: {
      type: "array",
      description: "AI-suggested better-fit cars (not live listings).",
      items: {
        type: "object",
        properties: {
          car: { type: "string", description: "e.g. 'BMW 320d M Sport (G20, 2021+)' or 'Audi A4 40 TDI'." },
          sameModelNewerYear: {
            type: "boolean",
            description: "True = better year/generation of the same car; false = a different car.",
          },
          reason: { type: "string", description: "Why it fits the profile better." },
        },
        required: ["car", "sameModelNewerYear", "reason"],
      },
    },
    vehicle: {
      type: "object",
      description: "Normalized key facts about the car, used to track its price across relistings.",
      properties: {
        make: { type: "string", description: "e.g. 'BMW'." },
        model: { type: "string", description: "e.g. '320d' or '3 Series'." },
        trim: { type: "string", description: "e.g. 'M Sport', 'SE'. Omit if unknown." },
        year: { type: "number", description: "Model/registration year, e.g. 2019." },
        mileageKm: { type: "number", description: "Odometer reading in kilometres." },
        fuel: { type: "string", description: "petrol | diesel | hybrid | ev | other." },
        transmission: { type: "string", description: "automatic | manual." },
        colour: { type: "string", description: "Exterior colour." },
      },
      required: ["make", "model", "year"],
    },
    priceEur: {
      type: "number",
      description: "Asking price as a plain number in euros. Omit entirely for POA / finance-only listings.",
    },
  },
  required: [
    "verdict",
    "score",
    "summary",
    "fitChips",
    "listingSnapshot",
    "assessment",
    "modelYearNotes",
    "alternatives",
  ],
} as const;
