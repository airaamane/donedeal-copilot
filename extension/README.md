# DoneDeal Copilot — browser extension

A Chrome / Edge extension that gives you an AI second opinion on a used-car
listing while you browse it. Open a listing on **DoneDeal**, **AutoTrader.ie**,
or **AutoTrader.co.uk**, click the toolbar icon, and it audits the car against
**your** buyer profile: a fit verdict and score, quick profile-match chips,
hidden-risk assessment, model/year notes, better-fit alternatives, and (when the
backend has price tracking enabled) the car's price history across relistings.

This is the **front end only**. It talks to the `car-audit` backend in this repo
(the one you deploy to Railway), which does the Gemini work. You point the
extension at your backend's URL once, and it remembers it.

```
 ┌──────────────┐   POST /audit          ┌─────────────────────┐   Gemini
 │  Extension   │ ─────────────────────▶ │  car-audit backend  │ ─────────▶ 🤖
 │ (this folder)│   { profile, url,      │   (Railway)         │
 │              │ ◀───────────────────── │                     │ ◀─────────
 └──────────────┘     Audit JSON         └─────────────────────┘
```

---

## 1. Prerequisites

You need the backend running and reachable over HTTPS before the extension is
useful.

1. **Deploy the backend** (the rest of this repo) to Railway (or anywhere). See
   the root [`README.md`](../README.md) and [`.env.example`](../.env.example).
2. Note two things from that deployment:
   - **Backend URL** — e.g. `https://your-app.up.railway.app`
   - **API key** — the value of `AUDIT_API_KEY`, if you set one (recommended).
     Leave it blank in the extension only if the backend runs without a key.
3. **CORS:** the backend defaults to `Access-Control-Allow-Origin: *`, so the
   extension can call it out of the box. If you lock it down with
   `ALLOWED_ORIGIN`, set it to your extension origin
   (`chrome-extension://<your-extension-id>`); the ID is shown on the
   extensions page after you load the extension.

---

## 2. Install (unpacked / developer mode)

The fastest way to run it, and what you'll use during development. The
`extension/` folder *is* the unpacked extension.

### Chrome (also Brave, Opera, Arc — any Chromium browser)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this **`extension/`** folder.
5. The DoneDeal Copilot icon appears in the toolbar. Pin it via the puzzle-piece
   menu for easy access.

### Microsoft Edge

1. Go to `edge://extensions`.
2. Turn on **Developer mode** (left sidebar).
3. Click **Load unpacked**.
4. Select this **`extension/`** folder.

> The extension is plain Manifest V3 with no build step — the source files in
> this folder load directly. No `npm install` or bundling needed.

---

## 3. First-run setup

1. Click the toolbar icon to open the popup.
2. Expand **Connection** and fill in:
   - **Backend URL** — your Railway URL (with or without a trailing slash; the
     extension appends `/audit` itself).
   - **X-API-Key** — your `AUDIT_API_KEY`, if the backend requires one.
3. Click **Test connection** — you should see **Connected ✓**.
4. Expand **Your profile** and set your budget, fuel, mileage, must-haves,
   deal-breakers, etc. Everything you enter is saved locally on this browser, so
   you only do it once.

---

## 4. Using it

1. Open a car listing on a supported site (DoneDeal, AutoTrader.ie,
   AutoTrader.co.uk).
2. Click the DoneDeal Copilot icon — the listing URL is filled in automatically.
3. Click **AUDIT THIS LISTING**.
4. Wait ~20s on the first run (the backend reads the page, then audits it). The
   result renders right in the popup.

Tips:

- **Page text** (Connection panel, on by default): the extension sends the
  rendered page text it can already see in your tab, so the backend can skip its
  own fetch. This is more reliable on **AutoTrader UK**, which blocks
  server-side fetches.
- The audit runs in the background, so it keeps going even if you close the
  popup — reopen it to see the finished result.
- You can also paste any supported listing URL into the box and audit a page
  you're not currently on (page-text sending is skipped in that case).

---

## 5. Package it for distribution

Both stores want a **ZIP of the extension folder's contents** (the
`manifest.json` must be at the root of the zip, not inside a subfolder).

From the repo root:

```bash
cd extension
zip -r ../donedeal-copilot-extension.zip . -x "*.DS_Store" "make-icons.mjs" "README.md"
```

That produces `donedeal-copilot-extension.zip` you can upload to either store.
(`make-icons.mjs` and this README are dev-only and excluded; including them is
harmless if you'd rather keep it simple.)

> Bump `"version"` in `manifest.json` for every store upload — stores reject a
> re-upload of an existing version number.

---

## 6. Publish on the Chrome Web Store

1. Create a developer account at
   <https://chrome.google.com/webstore/devconsole> (one-time US$5 fee).
2. **New item** → upload `donedeal-copilot-extension.zip`.
3. Fill in the store listing: description, at least one screenshot
   (1280×800 or 640×400), and a 128×128 icon (already in `icons/`).
4. Complete the **Privacy** tab:
   - Justify permissions: `activeTab` + `scripting` (read the open listing's
     text), `storage` (save your profile/settings), host access to the listing
     sites, and the user-granted backend host.
   - State that listing text + your profile are sent to **your** backend for the
     audit, and that no data is sold.
5. Submit for review. Approval typically takes a few hours to a few days.

---

## 7. Publish on Microsoft Edge Add-ons

1. Register at <https://partner.microsoft.com/dashboard/microsoftedge> (free).
2. **Create new extension** → upload the **same** `donedeal-copilot-extension.zip`
   (Edge is Chromium, so the MV3 package is identical).
3. Fill in listing details, properties, and the privacy/permissions
   justifications (same as Chrome above).
4. Submit for certification.

---

## 8. Distributing without a store (optional)

- **Share the folder / zip:** other developers can **Load unpacked** the folder
  (Section 2). Good for testing and small teams.
- **Self-hosted updates / enterprise:** Chromium supports force-installing an
  extension via group policy (`ExtensionInstallForcelist`) pointing at a
  self-hosted `.crx` + `update.xml`. See Chrome and Edge enterprise docs. This
  avoids the public stores but requires managing your own update manifest.
- Unpacked extensions are unsigned and will show a "developer mode" warning;
  store-published or policy-installed builds don't.

---

## 9. Permissions, explained

| Permission | Why |
| --- | --- |
| `activeTab` + `scripting` | Read the text of the listing tab you're on, so the backend can audit the page you actually see. |
| `storage` | Save your buyer profile, backend URL, and API key locally. |
| `host_permissions` (DoneDeal, AutoTrader) | Auto-detect when you're on a supported listing and read its content. |
| `optional_host_permissions` (any https) | Granted only for **your** backend URL the first time you audit/test, so the extension can call it. |

Your profile and the listing text are sent **only** to the backend URL you
configure. Nothing is sent anywhere else.

---

## 10. Rebuilding the icons

The PNGs in `icons/` are generated (no binary assets checked in by hand) with a
dependency-free Node script:

```bash
cd extension
node make-icons.mjs
```

Edit the colours/shape in `make-icons.mjs` and re-run to regenerate
`icon16/32/48/128.png`.

---

## Files in this folder

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 definition. |
| `popup.html` / `popup.css` / `popup.js` | The toolbar popup UI and logic. |
| `background.js` | Service worker that runs the `/audit` call (survives popup close). |
| `icons/` | Toolbar / store icons (16/32/48/128). |
| `make-icons.mjs` | Regenerates the icons. |
