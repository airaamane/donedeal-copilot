# Store Listing Copy — DoneDeal Copilot (Car Audit)

Paste-ready text for the Chrome Web Store and Microsoft Edge Add-ons listings.
Same content works for both. Fill the bracketed bits before submitting.

---

## Name

```
DoneDeal Copilot — Car Audit
```

## Category

Shopping (alternatively: Productivity).

## Summary / short description  (Chrome max 132 chars)

```
AI second opinion on used-car listings — audits DoneDeal & AutoTrader UK ads against your buyer profile.
```

## Single-purpose description  (Chrome requires this)

```
DoneDeal Copilot has a single purpose: when you open a supported used-car listing,
it audits that car against your saved buyer profile and shows an AI assessment —
a fit score, hidden risks, model-year notes, and better-fit alternatives.
```

## Detailed description

```
DoneDeal Copilot is your AI car-buying second opinion. Browsing a used car on
DoneDeal or AutoTrader UK? Open the popup and get an instant, honest read on the
car against YOUR priorities — not just a restatement of the ad.

You set your profile once (budget, fuel, transmission, mileage, must-haves, and
any deal-breakers), and it's saved locally on your browser. From then on, one
click audits the listing you're viewing.

What you get:
• Fit verdict and 0–100 score against your profile
• Quick match/mismatch chips for the facts that matter to you
• Hidden-risk assessment — the non-obvious things an expert would flag
• Model/year notes — common faults, facelifts, and what's particular to that car
• Better-fit alternatives — a smarter year of the same car, or a different one
• Price history across relistings, where available

Supported listings:
• DoneDeal car ads (donedeal.ie/cars-for-sale/…)
• AutoTrader UK car details (autotrader.co.uk/car-details/…)

Private by design:
• No account, no login, no ads, no tracking.
• Your profile and settings stay on your device.
• Listing details are sent only to the app's own backend to generate the audit,
  and are never sold or shared elsewhere.

Note: assessments are AI-generated guidance to help you ask better questions —
always verify with the seller and a professional inspection before buying.
```

## Privacy

- **Privacy policy URL:** `https://aimechanic.up.railway.app/privacy` (served by the backend from `public/privacy.html`)
- **Single purpose:** see above.

### Data usage disclosures (Chrome "Privacy practices" tab)

Declare that the extension collects:
- **Website content** — the listing page text, used to generate the audit.
- **User-provided content / preferences** — the buyer profile you enter.

And certify:
- Data is **not** sold or transferred to third parties for purposes unrelated to
  the single purpose.
- Data is **not** used for creditworthiness or lending.
- The extension does **not** use remote code (all logic ships in the package).

## Permission justifications  (paste into the store's permission prompts)

- **activeTab + scripting:** "Reads the text of the car-listing tab the user is on,
  only when they click Audit, so the listing can be assessed reliably (including
  sites that block server-side fetches)."
- **storage:** "Saves the user's buyer profile and settings locally so they don't
  re-enter them each time."
- **Host access (donedeal.ie, autotrader.co.uk):** "Detects supported car listings
  and reads their content to audit the page the user is viewing."

## Screenshots (you provide)

- At least one 1280×800 or 640×400 image — e.g. the popup showing a completed
  audit (verdict gauge + chips + assessment) over a DoneDeal listing.
- The 128×128 store icon is already in `extension/icons/icon128.png`.
