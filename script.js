(() => {
    // 1) Rendered visible text — what your browser sees *after* passing Cloudflare
    const text = document.body.innerText.replace(/\n{3,}/g, "\n\n").trim();

    // 2) Structured data — listing sites often embed the car as JSON-LD
    //    (Vehicle / Product / Offer). If present, this is cleaner than scraping text.
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
        .filter(Boolean);

    const has = (re) => re.test(text);
    console.log("=== client-side extraction test ===");
    console.log("URL:", location.href);
    console.log("innerText chars:", text.length, "| words:", text.split(/\s+/).length);
    console.log("signals →  price:", has(/£\s?\d|\bPOA\b/i),
        "| miles:", has(/\bmiles?\b/i),
        "| year/reg:", has(/\b(19|20)\d{2}\b/));
    console.log("JSON-LD blocks:", jsonLd.length, jsonLd);
    console.log("--- innerText preview (first 1500 chars) ---\n" + text.slice(0, 1500));

    window.__listing = { url: location.href, text, jsonLd };
    try { copy(text); console.log("\n✓ full innerText copied to clipboard (also at window.__listing)"); }
    catch { console.log("\n(full text at window.__listing.text)"); }
})();