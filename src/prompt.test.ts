import { describe, expect, test } from "bun:test";
import { AUDIT_SCHEMA, buildAuditMessage, buildExtractionMessage, formatProfile } from "./prompt.ts";
import type { Profile } from "./types.ts";

describe("formatProfile", () => {
  test("includes set fields and joins arrays", () => {
    const profile: Profile = {
      budgetMax: 30000,
      preferredMakes: ["BMW", "Audi"],
      maxMileageKm: 120000,
      fuel: "diesel",
    };
    const out = formatProfile(profile);
    expect(out).toContain("Max budget (€): 30000");
    expect(out).toContain("Preferred makes: BMW, Audi");
    expect(out).toContain("Max mileage (km): 120000");
    expect(out).toContain("Fuel: diesel");
  });

  test("omits empty, undefined, and empty-array fields", () => {
    const out = formatProfile({ budgetMax: 25000, preferredMakes: [], notes: "  " });
    expect(out).toContain("Max budget (€): 25000");
    expect(out).not.toContain("Preferred makes");
    expect(out).not.toContain("Other notes");
  });

  test("falls back when no details provided", () => {
    expect(formatProfile({})).toBe("(no profile details provided)");
  });
});

describe("buildAuditMessage", () => {
  test("includes both the profile and the trimmed listing markdown", () => {
    const msg = buildAuditMessage({ budgetMax: 30000 }, "  ### Vehicle\n* Price: €29,950  ");
    expect(msg).toContain("BUYER PROFILE:");
    expect(msg).toContain("Max budget (€): 30000");
    expect(msg).toContain("LISTING:");
    expect(msg).toContain("### Vehicle");
    expect(msg).toContain("€29,950");
  });
});

describe("buildExtractionMessage", () => {
  test("includes the trimmed URL", () => {
    const msg = buildExtractionMessage("  https://www.donedeal.ie/cars-for-sale/bmw/42108822  ");
    expect(msg).toContain("https://www.donedeal.ie/cars-for-sale/bmw/42108822");
    expect(msg).not.toContain("  https://"); // trimmed
  });
});

describe("AUDIT_SCHEMA", () => {
  test("is an object schema requiring the core audit fields", () => {
    expect(AUDIT_SCHEMA.type).toBe("object");
    expect(AUDIT_SCHEMA.required).toEqual([
      "verdict",
      "score",
      "summary",
      "fitChips",
      "listingSnapshot",
      "assessment",
      "modelYearNotes",
      "alternatives",
    ]);
    expect(AUDIT_SCHEMA.properties.verdict.enum).toContain("good_fit");
    expect(AUDIT_SCHEMA.properties.alternatives.items.properties.sameModelNewerYear.type).toBe(
      "boolean",
    );
  });
});
