"use strict";

// Runs the /audit request so a slow (~20s) call survives the popup closing.
// Results are persisted per-listing (keyed by URL) and broadcast to any open
// popup. Keeping a small per-URL map — rather than one "last audit" — means a
// previously audited car re-shows instantly, and switching cars never shows the
// wrong result.

const store = chrome.storage.local;
const getStore = (keys) => new Promise((res) => store.get(keys, res));
const setStore = (obj) => new Promise((res) => store.set(obj, res));

// Cap on remembered audits (evict oldest beyond this).
const MAX_AUDITS = 10;

// Normalize a listing URL to host + path (drop query/hash) so the same car
// matches across tracking params. Must mirror urlKey() in popup.js.
function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).toLowerCase().replace(/\/+$/, "");
  } catch {
    return (url || "").toLowerCase();
  }
}

async function saveAudit(url, entry) {
  const stored = await getStore(["audits"]);
  const map = stored.audits && typeof stored.audits === "object" ? stored.audits : {};
  map[urlKey(url)] = { ...entry, url, ts: Date.now() };

  const keys = Object.keys(map);
  if (keys.length > MAX_AUDITS) {
    keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0));
    for (const k of keys.slice(0, keys.length - MAX_AUDITS)) delete map[k];
  }
  await setStore({ audits: map });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "audit") {
    runAudit(msg); // fire-and-forget; result is broadcast + persisted
  }
  return false;
});

async function runAudit({ base, url, profile, listingText }) {
  await saveAudit(url, { status: "running" });

  const body = { profile: profile || {}, url };
  if (listingText) body.listingText = listingText;

  try {
    const res = await fetch(`${base}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }

    if (!res.ok) {
      const detail = (data && data.error) || `request failed (${res.status})`;
      // The backend explains 429s precisely (per-IP limit vs global capacity),
      // so prefer its message; fall back to a generic one if the body is empty.
      const msg = res.status === 429
        ? (data && data.error) || "Daily request limit reached — try again later."
        : `Error ${res.status}: ${detail}`;
      return finish(url, { ok: false, error: msg });
    }
    return finish(url, { ok: true, data });
  } catch (err) {
    return finish(url, {
      ok: false,
      error: "Network error — check the backend URL and that it's running.",
    });
  }
}

async function finish(url, outcome) {
  await saveAudit(url, outcome.ok
    ? { status: "done", data: outcome.data }
    : { status: "error", error: outcome.error });
  // Best-effort: no popup open means no receiver, which is fine. The url lets
  // the popup ignore a result for a listing the user has since navigated away from.
  chrome.runtime.sendMessage({ type: "auditResult", url, ...outcome }).catch(() => {});
}
