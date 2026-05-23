// Bun HTTP server for the car-audit backend.
//   POST /audit   { profile, url }  -> Audit JSON
//   GET  /health                    -> { ok: true }
//   GET  /                          -> local test console (public/index.html)
// Stateless; auth via a shared X-API-Key header (AUDIT_API_KEY env var).

import { timingSafeEqual } from "node:crypto";
import { AuditError, runAuditCached, type RunAuditOptions } from "./audit.ts";
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
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
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

function validateBody(raw: unknown): AuditRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadRequestError("body must be a JSON object");
  }
  const { profile, url } = raw as Record<string, unknown>;
  if (typeof url !== "string" || !isHttpUrl(url)) {
    throw new BadRequestError("`url` must be a valid http(s) URL");
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new BadRequestError("`profile` must be an object");
  }
  return { profile: profile as Profile, url };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Injectable deps so tests can stub the (cached) Gemini call.
export interface ServerDeps {
  runAudit: (profile: Profile, url: string, opts?: RunAuditOptions) => Promise<Audit>;
}
const defaultDeps: ServerDeps = { runAudit: runAuditCached };

export async function handleRequest(
  req: Request,
  deps: ServerDeps = defaultDeps,
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

    try {
      const audit = await deps.runAudit(body.profile, body.url);
      return json(audit, 200);
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
    fetch: (req) => handleRequest(req),
  });
  console.log(`car-audit backend listening on ${server.url}`);
}
