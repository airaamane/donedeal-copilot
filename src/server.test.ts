import { beforeEach, describe, expect, test } from "bun:test";
import { handleRequest, type ServerDeps } from "./server.ts";
import { AuditError } from "./audit.ts";
import type { Audit } from "./types.ts";

// Keep auth hermetic: default to dev mode (no key); tests opt into auth explicitly.
beforeEach(() => {
  delete process.env.AUDIT_API_KEY;
});

const sampleAudit: Audit = {
  verdict: "good_fit",
  score: 80,
  summary: "Great fit.",
  greenFlags: [],
  redFlags: [],
  watchFor: [],
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
