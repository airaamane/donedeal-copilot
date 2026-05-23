// Calls Gemini in JSON mode and returns a validated Audit object.

import { GoogleGenAI } from "@google/genai";
import type { Audit, Profile } from "./types.ts";
import { TtlCache, auditCacheKey } from "./cache.ts";
import {
  AUDIT_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildAuditMessage,
  buildExtractionMessage,
} from "./prompt.ts";

const MODEL = "gemini-3.5-flash";
const EXTRACT_TIMEOUT_MS = 45_000; // urlContext fetch adds latency
const AUDIT_TIMEOUT_MS = 30_000;

/** Thrown when the Gemini call fails or returns output we can't trust. */
export class AuditError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuditError";
  }
}

// Minimal slice of the SDK we depend on — lets tests inject a fake.
export interface GenerateResult {
  text?: string;
}
export type GenerateFn = (args: {
  model: string;
  contents: string;
  config: Record<string, unknown>;
}) => Promise<GenerateResult>;

let cachedGenerate: GenerateFn | undefined;
function defaultGenerate(): GenerateFn {
  if (!cachedGenerate) {
    const ai = new GoogleGenAI({}); // reads GEMINI_API_KEY from env
    cachedGenerate = (args) => ai.models.generateContent(args);
  }
  return cachedGenerate;
}

export interface RunAuditOptions {
  generate?: GenerateFn;
  extractTimeoutMs?: number;
  auditTimeoutMs?: number;
}

/**
 * profile + listing url → AI audit, in two stages:
 *   1. read the listing page into markdown (urlContext tool, no schema)
 *   2. audit that markdown against the profile (no tools, enforced JSON schema)
 *
 * Stage 2 must run without tools — enabling tools makes Gemini ignore the
 * response schema and freelance its own field names.
 *
 * Throws AuditError on any failure.
 */
export async function runAudit(
  profile: Profile,
  url: string,
  opts: RunAuditOptions = {},
): Promise<Audit> {
  const generate = opts.generate ?? defaultGenerate();
  const listing = await extractListing(generate, url, opts.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS);
  return auditListing(generate, profile, listing, opts.auditTimeoutMs ?? AUDIT_TIMEOUT_MS);
}

const defaultAuditCache = new TtlCache<Audit>({
  ttlMs: Number(process.env.CACHE_TTL_MS ?? 3_600_000),
  maxEntries: 500,
});

export interface RunAuditCachedOptions extends RunAuditOptions {
  cache?: TtlCache<Audit>;
}

/**
 * Cached wrapper around runAudit, keyed by (profile, url). Identical requests
 * within the TTL skip both Gemini calls. Listings change over time (price drops,
 * sold), so the default TTL is short (1 hour, overridable via CACHE_TTL_MS).
 */
export async function runAuditCached(
  profile: Profile,
  url: string,
  opts: RunAuditCachedOptions = {},
): Promise<Audit> {
  const cache = opts.cache ?? defaultAuditCache;
  const key = auditCacheKey(profile, url);

  const hit = cache.get(key);
  if (hit) return hit;

  const audit = await runAudit(profile, url, opts);
  cache.set(key, audit);
  return audit;
}

/** Stage 1: read the listing page into markdown using the urlContext tool. */
async function extractListing(
  generate: GenerateFn,
  url: string,
  timeoutMs: number,
): Promise<string> {
  let result: GenerateResult;
  try {
    result = await withTimeout(
      generate({
        model: MODEL,
        contents: buildExtractionMessage(url),
        config: {
          systemInstruction: EXTRACTION_SYSTEM_PROMPT,
          temperature: 0,
          tools: [{ urlContext: {} }],
        },
      }),
      timeoutMs,
    );
  } catch (err) {
    throw new AuditError("Failed to read the listing page", err);
  }

  const text = result.text;
  if (!text || text.trim() === "") {
    throw new AuditError("Listing page returned no content");
  }
  return text;
}

/** Stage 2: audit the extracted listing against the profile with an enforced schema. */
async function auditListing(
  generate: GenerateFn,
  profile: Profile,
  listing: string,
  timeoutMs: number,
): Promise<Audit> {
  let result: GenerateResult;
  try {
    result = await withTimeout(
      generate({
        model: MODEL,
        contents: buildAuditMessage(profile, listing),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: AUDIT_SCHEMA,
        },
      }),
      timeoutMs,
    );
  } catch (err) {
    throw new AuditError("Gemini audit request failed", err);
  }

  const text = result.text;
  if (!text || text.trim() === "") {
    throw new AuditError("Gemini returned an empty response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (err) {
    throw new AuditError("Gemini returned non-JSON output", err);
  }

  if (!isAudit(parsed)) {
    throw new AuditError("Gemini output did not match the Audit schema");
  }
  return parsed;
}

/**
 * Strip a leading/trailing markdown code fence if present. Combining the
 * urlContext tool with structured output sometimes makes Gemini wrap the JSON
 * in ```json ... ``` instead of returning it raw.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// --- Runtime validation of the model output ---------------------------------

const VERDICTS = ["good_fit", "proceed_with_caution", "avoid"];

function isFlagLike(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.title === "string" && typeof f.detail === "string";
}

export function isAudit(v: unknown): v is Audit {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  if (typeof a.verdict !== "string" || !VERDICTS.includes(a.verdict)) return false;
  if (typeof a.score !== "number" || Number.isNaN(a.score)) return false;
  if (typeof a.summary !== "string") return false;
  if (!Array.isArray(a.greenFlags) || !a.greenFlags.every(isFlagLike)) return false;
  if (!Array.isArray(a.redFlags) || !a.redFlags.every(isFlagLike)) return false;
  if (!Array.isArray(a.watchFor) || !a.watchFor.every(isFlagLike)) return false;
  return true;
}
