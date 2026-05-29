# Shipping Strategy — DoneDeal Copilot / Car Audit

**Status:** living runbook
**Scope:** how to take this project from the repo to users, safely and cheaply.

This is the operational counterpart to the design specs in
[`docs/superpowers/specs/`](./superpowers/specs/). It covers what ships, in what
order, how to verify it, how to keep Gemini spend bounded, and how to roll back.

---

## 1. What we're shipping

Two **coupled** artifacts:

| Artifact | Lives in | Ships to | Talks to |
| --- | --- | --- | --- |
| **car-audit backend** | repo root + `src/` | Railway (`aimechanic.up.railway.app`) | Gemini API |
| **DoneDeal Copilot extension** | `extension/` | Chrome Web Store + Edge Add-ons | the backend, over HTTPS |

The coupling that drives the release order: the extension calls the URL baked
into [`extension/config.js`](../extension/config.js). **The backend must be live
at that URL before the extension is useful**, so the backend ships first.

```
Extension ──POST /audit { profile, url, listingText? }──▶ Backend (Railway)
   (no API key)                                              ├─ stage 1: read listing (urlContext) *
                                                             └─ stage 2: audit (JSON schema) ──▶ Gemini
* skipped when the extension supplies listingText (AutoTrader UK)
```

---

## 2. Release phases

Ship in this order; do not skip the dogfood step.

1. **Pre-flight** — green tests + type-check (§7).
2. **Backend** — deploy to Railway, smoke-test (§3, §7).
3. **Extension config** — point `config.js` at the live backend, bump version (§5).
4. **Dogfood** — load unpacked, run a real audit end-to-end (§7).
5. **Store submission** — Chrome Web Store, then Edge (§5).
6. **Post-launch** — watch logs, costs, error rates (§8).

---

## 3. Backend deployment (Railway)

The backend is stateless except for the optional price-tracking Postgres.

### Environment variables

Every var is documented in [`.env.example`](../.env.example). For the **public,
extension-facing** deployment:

| Variable | Set to | Why |
| --- | --- | --- |
| `GEMINI_API_KEY` | **required** | the only hard requirement; the API the audit runs on |
| `AUDIT_API_KEY` | **leave UNSET** | the bundled extension sends no key; setting one makes every audit `401`. Spend is bounded by the caps below, not by a key |
| `TRUST_PROXY` | `true` | Railway sits behind a proxy; without this, per-IP rate limiting buckets everyone under the proxy IP |
| `ALLOWED_ORIGIN` | `*` (default) | extension origins (`chrome-extension://<id>`) differ per browser/build, so `*` is simplest given the backend is keyless + capped |
| `GLOBAL_DAILY_AUDITS` | `50` (default) or your budget | hard ceiling on **fresh** Gemini audits/day across all callers — your spend cap |
| `RATE_LIMIT_PER_DAY` | `10` (default) | per-IP fresh-audit limit |
| `CACHE_TTL_MS` | `3600000` (default) | 1h cache of `(profile, url)` results — repeat views are free |
| `GEMINI_EXTRACT_MODEL` / `GEMINI_AUDIT_MODEL` | default `gemini-3.5-flash` | override only if you change models; **confirm the model id is valid for your key** |
| `DATABASE_URL` | optional | enables price tracking. Reference Railway's Postgres var (`${{ Postgres.DATABASE_URL }}`). Unset = tracking disabled, audits still work |

### Steps

1. Deploy the repo to Railway (Bun is auto-detected; start command `bun run src/server.ts`).
2. Set the env vars above. **Double-check `AUDIT_API_KEY` is unset and `TRUST_PROXY=true`.**
3. (Optional) Add a Postgres service and wire `DATABASE_URL` for price history. Tables auto-create on first use.
4. Generate a public domain; confirm `/health` returns `{"ok":true}`.

---

## 4. Cost & abuse controls (keep Gemini spend bounded)

The backend is intentionally keyless, so defense is **layered** — each layer
strips traffic before it costs money:

1. **Route guard** — `/audit` rejects any URL that isn't a supported listing-detail
   route (`donedeal.ie/cars-for-sale/…`, `autotrader.co.uk/car-details/…`) with
   `400` **before any Gemini call**. Crafted/garbage URLs cost nothing.
2. **Cache** — identical `(profile, url)` within `CACHE_TTL_MS` (1h) returns the
   stored audit; no Gemini call, and it doesn't count against the daily cap.
3. **Per-IP limit** — `RATE_LIMIT_PER_DAY` (10) fresh audits per client IP per 24h.
4. **Global daily cap** — `GLOBAL_DAILY_AUDITS` (50) fresh audits/day across
   *everyone*. When hit, `/audit` returns `429` until the window rolls over. **This
   is the absolute ceiling on daily spend** — set it to whatever you're willing to pay.

If abused beyond comfort, tighten in this order: lower `GLOBAL_DAILY_AUDITS`,
lower `RATE_LIMIT_PER_DAY`, set `ALLOWED_ORIGIN` to your published extension
origin, and—last resort—set `AUDIT_API_KEY` (which requires shipping a keyed
extension build, breaking the "no key" UX).

> Note: the local test console at `GET /` is also public and posts to `/audit`.
> It's subject to the same caps, so exposure equals the extension's. Leave it or
> gate it behind your own auth if you prefer.

---

## 5. Extension packaging & submission

### Configure

1. Set `backendUrl` in [`extension/config.js`](../extension/config.js) to the live
   Railway URL.
2. Bump `"version"` in [`extension/manifest.json`](../extension/manifest.json) —
   stores reject re-uploads of an existing version.
3. Icons are generated from `icons/donedeal-copilot-icon.png` via
   `node make-icons.mjs` if you changed the artwork.

### Package

From the repo root:

```bash
cd extension
zip -r ../donedeal-copilot-extension.zip . \
  -x "*.DS_Store" "make-icons.mjs" "README.md" "icons/donedeal-copilot-icon.png"
```

(The README, the icon generator, and the 1 MB source artwork are dev-only —
excluding them keeps the package lean. `config.js` **must** be included.)

### Submit

- **Chrome Web Store:** developer console (one-time US$5), upload zip, fill listing
  + a 1280×800 screenshot, complete the Privacy tab.
- **Edge Add-ons:** same MV3 zip, free registration.

**Privacy/permissions justification (both stores):**
- `activeTab` + `scripting` — read the open listing's text so the backend can audit the page you see.
- `storage` — save your buyer profile and settings locally.
- `host_permissions` (`donedeal.ie`, `autotrader.co.uk`) — auto-detect supported listings and read their content.
- The backend is called over CORS, so it needs **no** host permission.
- State plainly: profile + listing text go **only** to the configured backend; nothing is sold.

---

## 6. Verification / smoke tests

### Pre-flight (local)

```bash
bun test            # expect: all pass
bunx tsc --noEmit   # expect: clean for src/ and extension/ (the root test.ts scratch file is ignorable)
```

### Backend (against the live deploy)

```bash
BASE="https://aimechanic.up.railway.app"

# 1. Liveness
curl -s "$BASE/health"                         # → {"ok":true}

# 2. Keyless check (auth runs before body parsing, so this spends NO Gemini):
#    400 = keyless (extension OK).  401 = AUDIT_API_KEY is set (extension would break).
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/audit" \
  -H "Content-Type: application/json" --data 'not-json'

# 3. Route guard (also no Gemini spend): a non-listing URL must 400
curl -s -X POST "$BASE/audit" -H "Content-Type: application/json" \
  --data '{"profile":{},"url":"https://www.donedeal.ie/"}' -w "\n%{http_code}\n"

# 4. CORS preflight returns the * header
curl -s -i -X OPTIONS "$BASE/audit" -H "Origin: chrome-extension://x" | grep -i access-control-allow-origin
```

### End-to-end (the one that costs a Gemini call)

Load the extension unpacked, open a **real** DoneDeal `/cars-for-sale/…` listing,
click **AUDIT THIS LISTING**. A rendered verdict = ship. A `502` = the model id or
`GEMINI_API_KEY` is wrong (not a code bug).

---

## 7. Rollback

- **Backend:** Railway → redeploy the previous deployment. It's stateless (the
  in-memory cache/limits reset; price-tracking rows persist in Postgres). Near-instant.
- **Config/URL:** if you must move the backend, update `config.js` and ship a new
  extension version — the URL is baked in, so an old build keeps calling the old URL.
- **Extension:** the stores don't offer instant revert. To pull a bad build, submit
  a fixed, version-bumped build (subject to review latency — hours to days). Keep the
  last-known-good zip so you can re-submit it quickly.

---

## 8. Post-launch monitoring

Watch, in roughly this priority:

- **Railway logs** for `audit failed:` (Gemini errors → 502), `Service is at today's
  audit limit` (global cap hit), and `price tracking failed:`/`threw:` (DB issues —
  non-fatal but worth noting).
- **Gemini billing/usage** in AI Studio — reconcile against `GLOBAL_DAILY_AUDITS`.
- **Error-rate signals:**
  - spike in `502` → model id or API key/quota problem.
  - frequent `429` → caps too tight for real demand (raise deliberately, watching cost),
    or abuse (tighten per §4).
  - spike in `400` → a supported site changed its URL structure; update `LISTING_ROUTES`
    in both `src/server.ts` **and** `extension/popup.js` (keep them in sync).
- **Store reviews / crash reports** for extension-side issues.

---

## 9. Versioning & cadence

- **Backend:** deploy anytime; stateless, no migration tooling (price-tracking tables
  use `CREATE TABLE IF NOT EXISTS`). Schema changes to those tables are drop-and-recreate
  for now (no production data worth keeping per the price-tracking spec).
- **Extension:** bump `manifest.json` `version` every store upload. Changes to
  `config.js` (backend URL) require a new published build.
- **Route changes:** `LISTING_ROUTES` is duplicated in `src/server.ts`,
  `extension/popup.js`, and `public/index.html` — change all three together.

---

## 10. Known limitations & risks

- **AutoTrader UK can't be read server-side** (Cloudflare). Mitigated: the extension
  sends the rendered page text it can already see (`Send page text`, on by default).
- **Model id validity** — `gemini-3.5-flash` must resolve for your key, or every audit
  502s. Confirm with the end-to-end test before relying on it.
- **Price tracking is unproven live** — unit-tested, but the Postgres path needs a real
  smoke test. Failures are swallowed (audit still returns), so it can't block shipping,
  but the price-history feature itself is unverified until checked against a live DB.
- **Process-local cache & limits** — a single Railway instance enforces them. Horizontal
  scaling would let each replica run its own caps, weakening the global ceiling; a shared
  store (e.g. Redis) is the future step if you scale out.
- **Keyless = open backend** — anyone with the URL can audit, bounded only by the caps.
  Accepted trade-off for a frictionless, non-technical audience.

---

## 11. Go / no-go checklist

- [ ] `bun test` green; `tsc` clean for `src/` + `extension/`.
- [ ] Backend deployed; `/health` → `200`.
- [ ] `AUDIT_API_KEY` **unset** (keyless probe returns `400`, not `401`).
- [ ] `TRUST_PROXY=true`; `GLOBAL_DAILY_AUDITS` set to an acceptable budget.
- [ ] Route guard rejects a non-listing URL with `400`.
- [ ] One **real** audit renders end-to-end through the unpacked extension.
- [ ] `config.js` points at the live backend; `manifest.json` version bumped.
- [ ] (If using price tracking) `DATABASE_URL` set; one audit writes a row.
- [ ] Store listing + privacy justifications ready; package excludes dev-only files.

When every box is checked, ship the backend, then submit the extension.
