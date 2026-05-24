// Bun HTTP server for the car-audit backend.
//   POST /audit   { profile, url }  -> Audit JSON
//   GET  /health                    -> { ok: true }
//   GET  /                          -> local test console (public/index.html)
// Stateless; auth via a shared X-API-Key header (AUDIT_API_KEY env var).

import { timingSafeEqual } from "node:crypto";
import { AuditError, runAuditCached, type RunAuditOptions } from "./audit.ts";
import { DailyRateLimiter, type RateLimitResult } from "./ratelimit.ts";
import type { Audit, AuditRequest, Profile } from "./types.ts";

class BadRequestError extends Error {}

/** Length-checked, timing-safe string comparison for the API key. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Expose-Headers":
      "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
  };
}

function json(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

/** Returns a 401 response if auth fails, otherwise null. No key set = dev mode. */
function checkAuth(req: Request): Response | null {
  const key = process.env.AUDIT_API_KEY;
  if (!key) return null; // dev mode (warned at startup)
  const provided = req.headers.get("x-api-key");
  if (provided === null || !safeEqual(provided, key)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

// Upper bound on client-supplied listing text, to reject oversized bodies.
const MAX_LISTING_TEXT_CHARS = 100_000;

function validateBody(raw: unknown): AuditRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadRequestError("body must be a JSON object");
  }
  const { profile, url, listingText } = raw as Record<string, unknown>;
  if (typeof url !== "string" || !isHttpUrl(url)) {
    throw new BadRequestError("`url` must be a valid http(s) URL");
  }
  if (!isAllowedListingUrl(url)) {
    throw new BadRequestError("`url` host is not a supported listing site");
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new BadRequestError("`profile` must be an object");
  }
  if (listingText !== undefined) {
    if (typeof listingText !== "string") {
      throw new BadRequestError("`listingText` must be a string");
    }
    if (listingText.length > MAX_LISTING_TEXT_CHARS) {
      throw new BadRequestError("`listingText` exceeds the maximum allowed length");
    }
  }
  return {
    profile: profile as Profile,
    url,
    ...(listingText !== undefined ? { listingText: listingText as string } : {}),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// --- Listing-site allow-list -------------------------------------------------

const DEFAULT_ALLOWED_HOSTS = ["donedeal.ie", "autotrader.ie", "autotrader.co.uk"];

/** Parsed ALLOWED_LISTING_HOSTS, or null when set to "*" (any host allowed). */
function parseAllowedHosts(): string[] | null {
  const raw = process.env.ALLOWED_LISTING_HOSTS?.trim();
  if (!raw) return DEFAULT_ALLOWED_HOSTS;
  if (raw === "*") return null;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** True if `value`'s host is an allowed listing site (or a subdomain of one). */
function isAllowedListingUrl(value: string): boolean {
  const hosts = parseAllowedHosts();
  if (hosts === null) return true;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// --- Per-IP daily rate limit -------------------------------------------------

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const defaultRateLimiter = new DailyRateLimiter({
  limit: intEnv("RATE_LIMIT_PER_DAY", 25),
  windowMs: intEnv("RATE_LIMIT_WINDOW_MS", 86_400_000),
});

/**
 * Best-effort client IP for rate limiting. Behind a trusted proxy (TRUST_PROXY
 * set) the socket IP is the proxy's, so use the X-Forwarded-For entry the proxy
 * appended (rightmost — spoof-resistant for a single hop); otherwise use the
 * socket peer IP. Falls back to "unknown" so a missing IP still shares a bucket.
 */
function clientIp(req: Request, socketIp?: string): string {
  if (process.env.TRUST_PROXY) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    const real = req.headers.get("x-real-ip");
    if (real && real.trim()) return real.trim();
  }
  return socketIp ?? "unknown";
}

/** Rate-limit response headers (X-RateLimit-* always; Retry-After when blocked). */
function rateLimitHeaders(rl: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Number.isFinite(rl.remaining)) {
    headers["X-RateLimit-Limit"] = String(rl.limit);
    headers["X-RateLimit-Remaining"] = String(rl.remaining);
    headers["X-RateLimit-Reset"] = String(Math.ceil(rl.resetAt / 1000));
  }
  if (!rl.allowed) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000)));
  }
  return headers;
}

// Injectable deps so tests can stub the (cached) Gemini call.
export interface ServerDeps {
  runAudit: (profile: Profile, url: string, opts?: RunAuditOptions) => Promise<Audit>;
  rateLimiter?: DailyRateLimiter;
}
const defaultDeps: ServerDeps = { runAudit: runAuditCached, rateLimiter: defaultRateLimiter };

export async function handleRequest(
  req: Request,
  deps: ServerDeps = defaultDeps,
  socketIp?: string,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return json({ ok: true }, 200);
  }

  // Local test console (open http://localhost:<port>/ in a browser).
  if (req.method === "GET" && url.pathname === "/") {
    return new Response(Bun.file(`${import.meta.dir}/../public/index.html`), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "POST" && url.pathname === "/audit") {
    const unauthorized = checkAuth(req);
    if (unauthorized) return unauthorized;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    let body: AuditRequest;
    try {
      body = validateBody(raw);
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }

    const rateLimiter = deps.rateLimiter ?? defaultRateLimiter;
    const rl = rateLimiter.consume(clientIp(req, socketIp));
    if (!rl.allowed) {
      return json({ error: "daily request limit reached" }, 429, rateLimitHeaders(rl));
    }

    try {
      const audit = await deps.runAudit(body.profile, body.url, { listingText: body.listingText });
      return json(audit, 200, rateLimitHeaders(rl));
    } catch (err) {
      if (err instanceof AuditError) {
        console.error("audit failed:", err.message, err.cause ?? "");
        return json({ error: "audit failed" }, 502);
      }
      console.error("unexpected error:", err);
      return json({ error: "internal error" }, 500);
    }
  }

  return json({ error: "not found" }, 404);
}

if (import.meta.main) {
  if (!process.env.AUDIT_API_KEY) {
    console.warn(
      "⚠  AUDIT_API_KEY not set — /audit is unauthenticated (dev mode). Set it before deploying.",
    );
  }
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    fetch: (req, srv) => handleRequest(req, defaultDeps, srv.requestIP(req)?.address),
  });
  console.log(`car-audit backend listening on ${server.url}`);
}
