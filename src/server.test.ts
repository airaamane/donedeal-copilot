import { beforeEach, describe, expect, test } from "bun:test";
import { handleRequest, type ServerDeps } from "./server.ts";
import { AuditError, CapacityError } from "./audit.ts";
import { DailyRateLimiter } from "./ratelimit.ts";
import type { Audit } from "./types.ts";

// Keep auth hermetic: default to dev mode (no key); tests opt into auth explicitly.
beforeEach(() => {
  delete process.env.AUDIT_API_KEY;
});

const sampleAudit: Audit = {
  verdict: "good_fit",
  market: "ie",
  score: 80,
  summary: "Great fit.",
  fitChips: [],
  listingSnapshot: "2019 BMW 320d.",
  assessment: [],
  modelYearNotes: [],
  alternatives: [],
};

const okDeps: ServerDeps = { runAudit: async () => sampleAudit };

const post = (body: unknown) =>
  new Request("http://localhost/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("handleRequest", () => {
  test("GET /health returns ok", async () => {
    const res = await handleRequest(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await handleRequest(
      new Request("http://localhost/audit", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  const VALID_URL = "https://www.donedeal.ie/cars-for-sale/bmw/42108822";

  test("POST /audit returns the audit on a valid body", async () => {
    const res = await handleRequest(
      post({ profile: { budgetMax: 30000 }, url: VALID_URL }),
      okDeps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleAudit);
  });

  test("400 on missing url", async () => {
    const res = await handleRequest(post({ profile: {} }), okDeps);
    expect(res.status).toBe(400);
  });

  test("400 on a non-http url", async () => {
    const res = await handleRequest(
      post({ profile: {}, url: "ftp://nope" }),
      okDeps,
    );
    expect(res.status).toBe(400);
  });

  test("400 on non-object profile", async () => {
    const res = await handleRequest(post({ profile: "x", url: VALID_URL }), okDeps);
    expect(res.status).toBe(400);
  });

  test("400 when listingText is not a string", async () => {
    const res = await handleRequest(
      post({ profile: {}, url: VALID_URL, listingText: 123 }),
      okDeps,
    );
    expect(res.status).toBe(400);
  });

  test("400 when listingText exceeds the size cap", async () => {
    const res = await handleRequest(
      post({ profile: {}, url: VALID_URL, listingText: "x".repeat(100_001) }),
      okDeps,
    );
    expect(res.status).toBe(400);
  });

  test("threads listingText through to runAudit", async () => {
    let seen: string | undefined = "unset";
    const deps: ServerDeps = {
      runAudit: async (_profile, _url, opts) => {
        seen = opts?.listingText;
        return sampleAudit;
      },
    };
    const res = await handleRequest(
      post({ profile: {}, url: VALID_URL, listingText: "pasted listing markdown" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(seen).toBe("pasted listing markdown");
  });

  test("400 on invalid JSON", async () => {
    const res = await handleRequest(post("{not json"), okDeps);
    expect(res.status).toBe(400);
  });

  test("502 when the audit fails", async () => {
    const failingDeps: ServerDeps = {
      runAudit: async () => {
        throw new AuditError("boom");
      },
    };
    const res = await handleRequest(
      post({ profile: {}, url: "https://www.donedeal.ie/cars-for-sale/bmw/42108822" }),
      failingDeps,
    );
    expect(res.status).toBe(502);
  });

  test("429 with a message when the global audit cap is reached", async () => {
    const cappedDeps: ServerDeps = {
      runAudit: async () => {
        throw new CapacityError("Service is at today's audit limit — please try again tomorrow.");
      },
    };
    const res = await handleRequest(post({ profile: {}, url: VALID_URL }), cappedDeps);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("today's audit limit");
  });

  test("400 when the url host is not a supported listing site", async () => {
    const res = await handleRequest(
      post({ profile: {}, url: "https://example.com/cars/123" }),
      okDeps,
    );
    expect(res.status).toBe(400);
  });

  test("allows an autotrader.co.uk car-details listing", async () => {
    const res = await handleRequest(
      post({ profile: {}, url: "https://www.autotrader.co.uk/car-details/202401011234567" }),
      okDeps,
    );
    expect(res.status).toBe(200);
  });

  test("400 for a supported host but a non-listing path", async () => {
    for (const url of [
      "https://www.donedeal.ie/cars", // section index, not an ad
      "https://www.autotrader.co.uk/car-search?make=BMW", // search, not a detail page
      "https://www.donedeal.ie/", // home page
    ]) {
      const res = await handleRequest(post({ profile: {}, url }), okDeps);
      expect(res.status).toBe(400);
    }
  });

  test("400 for sites we no longer audit", async () => {
    for (const url of [
      "https://www.autotrader.ie/car-details/123",
      "https://www.carsireland.ie/used-cars/123",
      "https://www.carzone.ie/used-cars/456",
    ]) {
      const res = await handleRequest(post({ profile: {}, url }), okDeps);
      expect(res.status).toBe(400);
    }
  });

  test("429 once the per-IP daily limit is exceeded", async () => {
    const deps: ServerDeps = {
      runAudit: async () => sampleAudit,
      rateLimiter: new DailyRateLimiter({ limit: 2 }),
    };
    const call = () => handleRequest(post({ profile: {}, url: VALID_URL }), deps);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  test("rate limit is tracked per client IP behind a trusted proxy", async () => {
    process.env.TRUST_PROXY = "1";
    try {
      const deps: ServerDeps = {
        runAudit: async () => sampleAudit,
        rateLimiter: new DailyRateLimiter({ limit: 1 }),
      };
      const fromIp = (ip: string) =>
        handleRequest(
          new Request("http://localhost/audit", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
            body: JSON.stringify({ profile: {}, url: VALID_URL }),
          }),
          deps,
        );
      expect((await fromIp("1.1.1.1")).status).toBe(200);
      expect((await fromIp("1.1.1.1")).status).toBe(429); // same IP, over limit
      expect((await fromIp("2.2.2.2")).status).toBe(200); // different IP, fresh window
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  test("404 for unknown routes", async () => {
    const res = await handleRequest(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
  });

  test("401 when AUDIT_API_KEY is set and header is wrong", async () => {
    const prev = process.env.AUDIT_API_KEY;
    process.env.AUDIT_API_KEY = "secret";
    try {
      const res = await handleRequest(
        post({ profile: {}, url: "https://www.donedeal.ie/cars-for-sale/bmw/42108822" }),
        okDeps,
      );
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.AUDIT_API_KEY;
      else process.env.AUDIT_API_KEY = prev;
    }
  });
});
