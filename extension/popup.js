"use strict";

const $ = (id) => document.getElementById(id);

// Listing-detail routes we audit (host + path prefix). Mirrors LISTING_ROUTES in
// the backend's server.ts; the audit button is only live on these exact pages.
const LISTING_ROUTES = [
  { host: "donedeal.ie", prefix: "/cars-for-sale/" },
  { host: "autotrader.co.uk", prefix: "/car-details/" },
];
// Keep under the server's MAX_LISTING_TEXT_CHARS (100_000).
const MAX_TEXT_CHARS = 95_000;

// Plain text/number profile fields. Fuel, transmission, and must-haves are chip
// groups (read separately); deal-breakers fold into the free-text notes.
const TEXT_FIELDS = ["budgetMax", "financePerMonthMax", "maxMileageKm", "minYear", "use", "notes"];
const NUMERIC = new Set(["budgetMax", "financePerMonthMax", "maxMileageKm", "minYear"]);

// --- storage -----------------------------------------------------------------

const store = chrome.storage.local;
const get = (keys) => new Promise((res) => store.get(keys, res));
const set = (obj) => new Promise((res) => store.set(obj, res));

// In-memory copy of the per-URL audit map (background.js owns the writes).
let auditsCache = {};

// --- helpers -----------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
// True only for the specific car-listing detail pages we audit (host + path).
function isAuditableUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  return LISTING_ROUTES.some(
    (r) => (host === r.host || host.endsWith(`.${r.host}`)) && path.startsWith(r.prefix),
  );
}
// Normalize a listing URL to host + path (drop query/hash) so the same car
// matches across tracking params. Must mirror urlKey() in background.js.
function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).toLowerCase().replace(/\/+$/, "");
  } catch {
    return (url || "").toLowerCase();
  }
}
function normalizeBase(raw) {
  let b = (raw || "").trim().replace(/\/+$/, "");
  if (b.endsWith("/audit")) b = b.slice(0, -"/audit".length);
  return b;
}

// The backend to call: the URL baked into config.js.
function resolveBase() {
  const builtin = (typeof COPILOT_CONFIG !== "undefined" && COPILOT_CONFIG.backendUrl) || "";
  return normalizeBase(builtin);
}

// --- chip groups (multi-select fuel / transmission / must-haves) -------------

function chipGroup(group) {
  return document.querySelector(`.chipgroup[data-group="${group}"]`);
}
function chipValues(group) {
  return [...document.querySelectorAll(`.chipgroup[data-group="${group}"] [aria-pressed="true"]`)]
    .map((b) => b.dataset.value);
}

// Inline freeform must-have: creates a selected chip before the "+ Add" input.
function addMustHave(value) {
  value = String(value).trim();
  if (!value) return;
  const grp = chipGroup("mustHaves");
  const existing = [...grp.querySelectorAll(".chip-btn")]
    .find((b) => b.dataset.value.toLowerCase() === value.toLowerCase());
  if (existing) { existing.setAttribute("aria-pressed", "true"); return; }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip-btn";
  btn.dataset.value = value;
  btn.dataset.custom = "true";
  btn.setAttribute("aria-pressed", "true");
  btn.textContent = value;
  grp.insertBefore(btn, $("mustHaveAdd"));
}

// Restore a saved chip selection: press known chips, recreate custom must-haves.
function applyChipSelection(group, values) {
  const grp = chipGroup(group);
  if (!grp) return;
  grp.querySelectorAll('.chip-btn[data-custom="true"]').forEach((b) => b.remove());
  grp.querySelectorAll(".chip-btn").forEach((b) => b.setAttribute("aria-pressed", "false"));
  // Tolerate a legacy scalar value (older builds saved fuel/transmission as a string).
  const list = Array.isArray(values) ? values : values ? [values] : [];
  for (const val of list) {
    const existing = [...grp.querySelectorAll(".chip-btn")]
      .find((b) => b.dataset.value.toLowerCase() === String(val).toLowerCase());
    if (existing) existing.setAttribute("aria-pressed", "true");
    else if (group === "mustHaves") addMustHave(val);
  }
}

function buildProfile() {
  const p = {};
  for (const id of TEXT_FIELDS) {
    const v = $(id).value.trim();
    if (v === "") continue;
    p[id] = NUMERIC.has(id) ? Number(v) : v;
  }
  const fuel = chipValues("fuel");
  const transmission = chipValues("transmission");
  const mustHaves = chipValues("mustHaves");
  if (fuel.length) p.fuel = fuel;
  if (transmission.length) p.transmission = transmission;
  if (mustHaves.length) p.mustHaves = mustHaves;
  return p;
}

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = isError ? "error" : "";
}

// The "running" indicator: an animated sparkle + label shown while an audit is
// in flight (set as HTML, not text, so the inline SVG renders).
const SPARKLE_SVG =
  '<svg class="spark" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M19.954 0H19l-1 3-3 1v1l3 1 1 3h.954L21 6l3-1V4l-3-1-1.046-3ZM9.907 6H8l-2 6-6 2v2l6 2 2 6h1.907L12 18l6-2v-2l-6-2-2.093-6Z"></path></svg>';

function setRunning() {
  const el = $("status");
  el.className = "running";
  el.innerHTML = `${SPARKLE_SVG}<span>AI mechanic is running checks…</span>`;
}

function clearResult() {
  const r = $("result");
  r.style.display = "none";
  r.innerHTML = "";
}

// --- load / persist state ----------------------------------------------------

async function loadState() {
  const s = await get(["profile", "sendPageText", "audits"]);
  const profile = s.profile || {};
  for (const id of TEXT_FIELDS) $(id).value = profile[id] ?? "";
  applyChipSelection("fuel", profile.fuel);
  applyChipSelection("transmission", profile.transmission);
  applyChipSelection("mustHaves", profile.mustHaves);
  $("sendPageText").checked = s.sendPageText !== false;
  auditsCache = s.audits && typeof s.audits === "object" ? s.audits : {};
}

function persistProfile() { set({ profile: buildProfile() }); }
function persistConn() { set({ sendPageText: $("sendPageText").checked }); }

// Show the stored audit for whatever listing is currently in the URL box — or a
// clean slate if none. Called on open and whenever the URL changes, so a result
// only ever appears on the car it describes.
function refreshResult() {
  const url = $("url").value.trim();
  const auditable = isAuditableUrl(url);
  const entry = url ? auditsCache[urlKey(url)] : null;

  clearResult();
  setStatus("");

  let running = false;
  if (entry) {
    if (entry.status === "done" && entry.data) {
      render(entry.data);
    } else if (entry.status === "running" && Date.now() - entry.ts < 90_000) {
      setRunning();
      running = true;
    } else if (entry.status === "error") {
      setStatus(entry.error || "Last audit failed.", true);
    }
  }

  // Only the supported listing-detail pages get a live audit button.
  $("go").disabled = running || !auditable;
  updateSiteNote(url, auditable);
}

// The guidance line under the URL bar.
function updateSiteNote(url, auditable) {
  if (auditable) { setNote("Ready to audit this listing.", "ok"); return; }
  if (url) {
    setNote("Not an auditable page — open a DoneDeal ad (donedeal.ie/cars-for-sale/…) or an AutoTrader UK car-details page.", "warn");
    return;
  }
  setNote("Open a DoneDeal or AutoTrader UK car listing, or paste its URL above.", "");
}

// --- active tab --------------------------------------------------------------

let activeTabId = null;

async function initActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id ?? null;
  // Prefill from the active tab only when it's an auditable listing page.
  if (isAuditableUrl(tab.url || "") && !$("url").value) $("url").value = tab.url;
}

function setNote(msg, cls) {
  const el = $("siteNote");
  el.textContent = msg || "";
  el.className = "note" + (cls ? " " + cls : "");
}

// --- page-text extraction ----------------------------------------------------

async function extractPageText(targetUrl) {
  if (!$("sendPageText").checked || activeTabId == null) return undefined;
  // Only scrape when the active tab IS the listing we're auditing.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || hostOf(tab.url || "") !== hostOf(targetUrl)) return undefined;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => (document.body ? document.body.innerText : ""),
    });
    const text = (res && res.result) ? String(res.result).trim() : "";
    return text ? text.slice(0, MAX_TEXT_CHARS) : undefined;
  } catch {
    return undefined; // fall back to server-side fetch
  }
}

// --- run audit ---------------------------------------------------------------

async function runAudit() {
  const url = $("url").value.trim();
  const base = resolveBase();

  if (!base) {
    setStatus("No backend is configured. Set backendUrl in config.js.", true);
    return;
  }
  if (!url) { setStatus("Enter or open a listing URL first.", true); return; }
  if (!isAuditableUrl(url)) {
    setStatus("That page isn't an auditable car listing (DoneDeal /cars-for-sale/ or AutoTrader UK /car-details/).", true);
    return;
  }

  persistProfile();
  persistConn();
  clearResult();
  $("go").disabled = true;
  setRunning();

  const listingText = await extractPageText(url);

  chrome.runtime.sendMessage({
    type: "audit",
    base,
    url,
    profile: buildProfile(),
    listingText,
  });
  // The result arrives via the runtime message listener below (when the popup
  // stays open); background also persists it per-URL for the next popup open.
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "auditResult") return;
  // Cache the result for its listing...
  auditsCache[urlKey(msg.url)] = msg.ok
    ? { status: "done", data: msg.data, url: msg.url, ts: Date.now() }
    : { status: "error", error: msg.error, url: msg.url, ts: Date.now() };
  // ...but only reflect it in the UI if the user is still on that listing.
  if (urlKey(msg.url) !== urlKey($("url").value.trim())) return;
  $("go").disabled = false;
  if (msg.ok) {
    setStatus("");
    render(msg.data);
  } else {
    clearResult();
    setStatus(msg.error || "Audit failed.", true);
  }
});

// --- render (ported from the backend's test console) -------------------------

// Verdict colours reference CSS tokens so the popup stays single-sourced with
// the instrument theme in popup.css.
const VERDICT = {
  good_fit:             { label: "Good fit",              color: "var(--v-good)" },
  proceed_with_caution: { label: "Proceed with caution",  color: "var(--v-caution)" },
  avoid:                { label: "Avoid",                 color: "var(--v-avoid)" },
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render(audit) {
  const v = VERDICT[audit.verdict] || { label: audit.verdict, color: "var(--color-muted)" };
  const score = Math.max(0, Math.min(100, Number(audit.score) || 0));

  const chips = (audit.fitChips || []).map((c) =>
    `<span class="chip ${esc(c.status)}">${esc(c.label)}</span>`).join("");
  const chipsBlock = chips ? `<div class="chips">${chips}</div>` : "";

  const insights = (arr, cls) => (arr || []).map((f) => `
    <div class="item ${cls}">
      <div class="t">${esc(f.title)}</div>
      <div class="d">${esc(f.detail)}</div>
    </div>`).join("");

  const insightSection = (title, arr, cls) =>
    (arr && arr.length) ? `<div class="flags"><h3><span class="star">★</span> ${title}</h3>${insights(arr, cls)}</div>` : "";

  const alts = (audit.alternatives || []).map((a) => `
    <div class="item alt">
      <div class="t">${esc(a.car)}<span class="alt-tag">${a.sameModelNewerYear ? "newer year" : "different car"}</span></div>
      <div class="d">${esc(a.reason)}</div>
    </div>`).join("");
  const altSection = alts ? `<div class="flags"><h3><span class="star">★</span> Better options</h3>${alts}</div>` : "";

  $("result").innerHTML = `
    <div class="card">
      <div class="verdict">
        <div class="ring" style="background: conic-gradient(${v.color} ${score * 3.6}deg, var(--color-rule) 0deg);">
          <span class="num">${score}</span>
        </div>
        <div class="meta">
          <span class="badge" style="background: color-mix(in oklch, ${v.color} 18%, transparent); color:${v.color};">${esc(v.label)}</span>
          <p class="summary">${esc(audit.summary || "")}</p>
        </div>
      </div>
      ${chipsBlock}
      ${audit.listingSnapshot ? `<p class="snapshot">${esc(audit.listingSnapshot)}</p>` : ""}
      ${insightSection("Assessment", audit.assessment, "assess")}
      ${insightSection("This model year", audit.modelYearNotes, "year")}
      ${altSection}
      ${priceBlock(audit.priceHistory)}
    </div>`;
  $("result").style.display = "block";
}

function priceBlock(h) {
  if (!h) return "";
  const sym = h.market === "uk" ? "£" : "€";
  const money = (n) => sym + Number(n).toLocaleString();
  const date = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
  const obs = (h.observations || []).map((o) => `
    <div class="item">
      <div class="t">${money(o.price)}<span class="alt-tag">${Number(o.mileageKm).toLocaleString()} km</span></div>
      <div class="d">${esc(date(o.observedAt))}</div>
    </div>`).join("");
  const n = (h.observations || []).length;
  return `<div class="flags">
    <h3><span class="star">★</span> Price history (${esc((h.market || "").toUpperCase())})</h3>
    <p class="snapshot">${n} observation${n === 1 ? "" : "s"}, current ${money(h.currentPrice)}.</p>
    ${obs}
  </div>`;
}

// --- wire up -----------------------------------------------------------------

// Chip groups: toggle on click (all groups are multi-select), then persist.
document.querySelectorAll(".chipgroup").forEach((group) => {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip-btn");
    if (!btn) return;
    const on = btn.getAttribute("aria-pressed") === "true";
    btn.setAttribute("aria-pressed", on ? "false" : "true");
    persistProfile();
  });
});
$("mustHaveAdd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addMustHave(e.target.value); e.target.value = ""; persistProfile(); }
});

for (const id of TEXT_FIELDS) $(id).addEventListener("change", persistProfile);
$("sendPageText").addEventListener("change", persistConn);
$("go").addEventListener("click", runAudit);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") runAudit(); });
// Switching the target listing swaps in that listing's stored result (or clears).
$("url").addEventListener("input", refreshResult);

(async () => {
  await loadState();
  await initActiveTab();
  refreshResult();
})();
