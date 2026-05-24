// Throwaway smoke test for the live Postgres price-tracking path.
//
//   bun scripts/smoke-db.ts
//
// Reads DATABASE_URL from the environment (.env is auto-loaded by Bun). Use the
// PUBLIC Railway connection string when running from your laptop — the internal
// *.railway.internal host is only reachable from inside Railway.
//
// It drives the real PostgresPriceStore: bootstraps the tables, records two
// observations for a uniquely-tagged test car (a price drop), reads the history
// back, asserts it, then deletes its own rows. Safe to run against the real DB.

import { SQL } from "bun";
import { DbPriceTracker, PostgresPriceStore } from "../src/pricetracker.ts";
import type { Audit, Vehicle } from "../src/types.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL not set. Put the PUBLIC Railway Postgres URL in .env (locally),\n" +
      "e.g. DATABASE_URL=postgresql://...@<something>.proxy.rlwy.net:<port>/railway",
  );
  process.exit(1);
}

// Unique make so we never collide with real data and can clean up precisely.
const TAG = `SMOKETEST-${Date.now()}`;
const vehicle: Vehicle = {
  make: TAG,
  model: "320d",
  trim: "M Sport",
  year: 2019,
  mileageKm: 100_000,
  fuel: "diesel",
  transmission: "automatic",
  colour: "black",
};
const audit = (priceEur: number, mileageKm: number): Audit => ({
  verdict: "good_fit",
  score: 80,
  summary: "smoke",
  fitChips: [],
  listingSnapshot: "smoke",
  assessment: [],
  modelYearNotes: [],
  alternatives: [],
  vehicle: { ...vehicle, mileageKm },
  priceEur,
});

const cleanup = new SQL(url);

try {
  const store = new PostgresPriceStore(url);
  const tracker = new DbPriceTracker(store);

  console.log("1) first sighting…");
  const h1 = await tracker.record(audit(30_000, 100_000), "https://donedeal.ie/smoke-old");
  console.log("   history:", JSON.stringify(h1));

  console.log("2) relisted lower, new URL, driven a bit…");
  const h2 = await tracker.record(audit(28_500, 104_000), "https://donedeal.ie/smoke-new");
  console.log("   history:", JSON.stringify(h2));

  // Assertions
  const ok =
    h1?.observations.length === 1 &&
    h2?.observations.length === 2 &&
    h2?.currentPriceEur === 28_500 &&
    h2?.changeSinceFirstEur === -1_500 &&
    h2?.lastChange?.deltaEur === -1_500;

  const cars = (await cleanup`SELECT count(*)::int AS n FROM cars WHERE make = ${TAG}`) as { n: number }[];
  console.log(`3) rows in cars for this test car: ${cars[0]?.n} (expected 1 — matched, not duplicated)`);

  if (ok && cars[0]?.n === 1) {
    console.log("\n✅ PASS — live Postgres path works (create, match-on-relist, price-point, history).");
  } else {
    console.log("\n❌ FAIL — see output above.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\n❌ ERROR talking to Postgres:", err);
  process.exitCode = 1;
} finally {
  // Always remove the test car (observations cascade).
  const del = await cleanup`DELETE FROM cars WHERE make = ${TAG}`;
  console.log(`\n4) cleanup: deleted test car rows (make=${TAG}).`);
  void del;
  await cleanup.end();
}
