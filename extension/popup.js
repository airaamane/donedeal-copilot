"use strict";

const $ = (id) => document.getElementById(id);

// Hosts the backend will accept (mirrors ALLOWED_LISTING_HOSTS on the server).
const SUPPORTED_HOSTS = ["donedeal.ie", "autotrader.ie", "autotrader.co.uk"];
// Keep under the server's MAX_LISTING_TEXT_CHARS (100_000).
const MAX_TEXT_CHARS = 95_000;

const PROFILE_FIELDS = [
  "budgetMax", "financePerMonthMax", "fuel", "transmission",
  "maxMileageKm", "minYear", "use", "mustHaves", "dealBreakers", "notes",
];
const NUMERIC = new Set(["budgetMax", "financePerMonthMax", "maxMileageKm", "minYear"]);
const LIST = new Set(["mustHaves", "dealBreakers"]);

// --- storage -----------------------------------------------------------------

const store = chrome.storage.local;
const get = (keys) => new Promise((res) => store.get(keys, res));
const set = (obj) => new Promise((res) => store.set(obj, res));

// --- helpers -----------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
function isSupportedHost(host) {
  return SUPPORTED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
function normalizeBase(raw) {
  let b = (raw || "").trim().replace(/\/+$/, "");
  if (b.endsWith("/audit")) b = b.slice(0, -"/audit".length);
  return b;
}

// The backend to call: a per-browser override (Advanced) wins, otherwise the
// URL baked into config.js. Normal users never set the override.
function resolveBase() {
  const override = normalizeBase($("backendUrl").value);
  if (override) return override;
  const builtin = (typeof COPILOT_CONFIG !== "undefined" && COPILOT_CONFIG.backendUrl) || "";
  return normalizeBase(builtin);
}

function buildProfile() {
  const p = {};
  for (const id of PROFILE_FIELDS) {
    const v = $(id).value.trim();
    if (v === "") continue;
    if (NUMERIC.has(id)) p[id] = Number(v);
    else if (LIST.has(id)) p[id] = v.split(",").map((s) => s.trim()).filter(Boolean);
    else p[id] = v;
  }
  return p;
}

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = isError ? "error" : "";
}

// --- load / persist state ----------------------------------------------------

async function loadState() {
  const s = await get(["profile", "backendUrl", "sendPageText", "lastAudit"]);
  const profile = s.profile || {};
  for (const id of PROFILE_FIELDS) {
    const v = profile[id];
    $(id).value = Array.isArray(v) ? v.join(", ") : v ?? "";
  }
  $("backendUrl").value = s.backendUrl || "";
  $("sendPageText").checked = s.sendPageText !== false;

  restoreLastAudit(s.lastAudit);
}

function persistProfile() { set({ profile: buildProfile() }); }
function persistConn() {
  set({
    backendUrl: $("backendUrl").value.trim(),
    sendPageText: $("sendPageText").checked,
  });
}

function restoreLastAudit(last) {
  if (!last) return;
  if (last.status === "running" && Date.now() - last.ts < 90_000) {
    setStatus("Auditing… (this can take ~20s on a first run)");
    $("go").disabled = true;
  } else if (last.status === "done" && last.data) {
    render(last.data);
  } else if (last.status === "error") {
    setStatus(last.error || "Last audit failed.", true);
  }
}

// --- active tab --------------------------------------------------------------

let activeTabId = null;

async function initActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id ?? null;
  const url = tab.url || "";
  const host = hostOf(url);
  if (isSupportedHost(host)) {
    if (!$("url").value) $("url").value = url;
    setNote(`On ${host} — ready to audit.`, "ok");
  } else if (url) {
    setNote("This page isn't a supported listing. Paste a DoneDeal or AutoTrader URL above.", "warn");
  }
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

// --- optional permission for the user's backend origin -----------------------

async function ensureBackendPermission(base) {
  let origin;
  try { origin = new URL(base).origin + "/*"; } catch { return; }
  // Call request() directly (no preceding await) so it stays inside the click's
  // user gesture; Chrome resolves without a prompt if it's already granted.
  // Non-fatal if it throws — the call still works via CORS when the backend
  // allows the extension origin (the default `Access-Control-Allow-Origin: *`).
  try { await chrome.permissions.request({ origins: [origin] }); } catch { /* ignore */ }
}

// --- run audit ---------------------------------------------------------------

async function runAudit() {
  const url = $("url").value.trim();
  const base = resolveBase();

  if (!base) {
    $("advancedPanel").open = true;
    setStatus("No backend is configured. Set a Backend URL under Advanced.", true);
    return;
  }
  if (!url) { setStatus("Enter or open a listing URL first.", true); return; }
  if (!isSupportedHost(hostOf(url))) {
    setStatus("That URL isn't a supported listing site (DoneDeal / AutoTrader).", true);
    return;
  }

  persistProfile();
  persistConn();
  $("result").style.display = "none";
  $("go").disabled = true;
  setStatus("Reading the listing and auditing… (first run can take ~20s)");

  await ensureBackendPermission(base);
  const listingText = await extractPageText(url);

  chrome.runtime.sendMessage({
    type: "audit",
    base,
    url,
    profile: buildProfile(),
    listingText,
  });
  // The result arrives via the runtime message listener below (survives popup
  // staying open); background also persists it for the next popup open.
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "auditResult") return;
  $("go").disabled = false;
  if (msg.ok) {
    setStatus("");
    render(msg.data);
  } else {
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

for (const id of PROFILE_FIELDS) $(id).addEventListener("change", persistProfile);
for (const id of ["backendUrl", "sendPageText"]) $(id).addEventListener("change", persistConn);
$("go").addEventListener("click", runAudit);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") runAudit(); });

loadState();
initActiveTab();
