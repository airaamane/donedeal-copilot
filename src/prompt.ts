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

export const SYSTEM_PROMPT = `You are a car-buying copilot for the Irish used-car market (DoneDeal, dealers, and private sellers).

You receive a buyer PROFILE and a LISTING (markdown extracted from the listing page). Audit how well the car fits this specific buyer, and surface what a savvy buyer would notice.

If the LISTING indicates the page could not be read or is not a car listing, return verdict "proceed_with_caution", a low score, and a red flag explaining that the listing could not be read.

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
- If the profile is sparse, audit the car on general merit and say what profile info would sharpen the verdict.`;

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

/** JSON Schema for the Audit response. Passed to config.responseFormat.text.schema. */
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
    greenFlags: {
      type: "array",
      description: "Positives — why the car fits the profile.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short chip label." },
          detail: { type: "string", description: "One-sentence explanation." },
        },
        required: ["title", "detail"],
      },
    },
    redFlags: {
      type: "array",
      description: "Concerns versus the profile or general soundness.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short chip label." },
          detail: { type: "string", description: "One-sentence explanation." },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Drives colour intensity.",
          },
        },
        required: ["title", "detail", "severity"],
      },
    },
    watchFor: {
      type: "array",
      description: "Things to verify or ask the seller before buying.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short chip label." },
          detail: { type: "string", description: "One-sentence explanation." },
          suggestHistoryCheck: {
            type: "boolean",
            description: "True if this item warrants a paid history report (Cartell/Motorcheck).",
          },
        },
        required: ["title", "detail", "suggestHistoryCheck"],
      },
    },
  },
  required: ["verdict", "score", "summary", "greenFlags", "redFlags", "watchFor"],
} as const;
