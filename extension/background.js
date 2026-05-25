"use strict";

// Runs the /audit request so a slow (~20s) call survives the popup closing.
// The result is persisted to storage and broadcast back to any open popup.

const store = chrome.storage.local;
const setStore = (obj) => new Promise((res) => store.set(obj, res));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "audit") {
    runAudit(msg); // fire-and-forget; result is broadcast + persisted
  }
  return false;
});

async function runAudit({ base, url, profile, listingText }) {
  await setStore({ lastAudit: { status: "running", url, ts: Date.now() } });

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
  await setStore({
    lastAudit: outcome.ok
      ? { status: "done", url, data: outcome.data, ts: Date.now() }
      : { status: "error", url, error: outcome.error, ts: Date.now() },
  });
  // Best-effort: no popup open means no receiver, which is fine.
  chrome.runtime.sendMessage({ type: "auditResult", ...outcome }).catch(() => {});
}
