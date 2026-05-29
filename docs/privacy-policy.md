# Privacy Policy — DoneDeal Copilot (Car Audit)

**Effective date:** _<set on publish, e.g. 2026-05-28>_
**Contact:** _<your contact email>_

DoneDeal Copilot ("the extension") gives you an AI second opinion on a used-car
listing you are viewing. This policy explains exactly what data the extension
handles, where it goes, and what is (and isn't) stored. It is written to match
what the software actually does.

## What the extension collects

The extension only acts when **you** click its toolbar icon and run an audit. At
that point it handles:

- **Your buyer profile** — the preferences you enter in the popup: budget and
  finance, fuel and transmission, max mileage, earliest year, intended use,
  must-haves, and free-text notes.
- **The listing URL** — the address of the car listing you choose to audit.
- **The listing page text** — when "Send page text" is enabled (the default), the
  extension reads the visible text of the listing tab you are on, so the listing
  can be analysed even on sites that block server-side fetches. It reads this only
  for the listing you are actively auditing.

The extension does **not** collect your name, email, location, browsing history,
or any identifier, and it has no accounts, logins, ads, or third-party analytics
or tracking.

## How the data is used and where it goes

When you run an audit, your profile, the listing URL, and (if enabled) the listing
page text are sent over HTTPS to the audit backend operated by the developer
(`aimechanic.up.railway.app`). The backend uses that information to read and
assess the listing via Google's **Gemini API** and returns a structured audit,
which is shown in the popup.

- Data is sent **only** to that backend. It is not sold, rented, or shared with any
  other party.
- The listing content is processed by Google's Gemini API to generate the audit.
  Google's handling of that data is governed by its own terms
  (https://ai.google.dev/gemini-api/terms and https://policies.google.com/privacy).

## What is stored

- **In your browser (local only):** your profile, your settings, and your most
  recent audit results are saved with the browser's local extension storage
  (`chrome.storage.local`) so you don't re-enter them. This never leaves your
  device except as part of an audit request you initiate, and you can clear it by
  removing the extension.
- **On the backend:** the audit service is stateless and does not store your
  profile. To bound usage it processes your network address (IP) transiently in
  memory for rate-limiting; this is not persisted. If price-history tracking is
  enabled, the backend may record **anonymous** car facts (make, model, year,
  mileage, price), the listing URL, and a timestamp to track a car's price across
  relistings. These records are not linked to you, your profile, or your identity.

## Permissions

- **activeTab + scripting** — to read the text of the car listing tab you are on
  when you ask for an audit.
- **storage** — to save your profile and settings locally.
- **Host access** (`donedeal.ie`, `autotrader.co.uk`) — to detect supported
  listings and read their content. The backend is called over standard web
  requests (CORS) and needs no host permission.

## Data retention and your choices

- Local data persists until you clear it or remove the extension.
- You control what is sent: nothing leaves your device unless you click to audit a
  listing. You can disable "Send page text" in the Advanced panel.

## Changes

This policy may be updated; material changes will be reflected by a new effective
date above.

## Contact

Questions about this policy: _<your contact email>_.
