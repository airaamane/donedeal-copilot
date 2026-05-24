# car-audit backend

A small [Bun](https://bun.com) HTTP backend that audits a used-car listing for a
specific buyer. Given a buyer profile and a listing URL, it uses Gemini to read
the page and return a structured audit: a fit verdict and score, quick
profile-fit chips, hidden-risk assessment, model/year notes, and better-fit
alternatives. It can also track a car's asking price across relistings over time.

The audit runs in two stages:

1. **Read** the listing page into clean markdown (Gemini `urlContext` tool).
2. **Audit** that markdown against the profile with an enforced JSON schema.

See the design docs in [`docs/superpowers/specs/`](docs/superpowers/specs/) for
the full background.

## Setup

Install dependencies:

```bash
bun install
```

Copy the example environment file and set at least `GEMINI_API_KEY`:

```bash
cp .env.example .env
```

Every variable is documented in [`.env.example`](.env.example). Only
`GEMINI_API_KEY` is required; `AUDIT_API_KEY` is strongly recommended before
deploying (without it the `/audit` endpoint runs unauthenticated in dev mode).

## Running

```bash
bun run dev     # watch mode, reloads on change
bun start       # run once
```

The server listens on `PORT` (default `8787`). Open
`http://localhost:8787/` in a browser for a local test console.

## Endpoints

| Method | Path      | Description                                          |
| ------ | --------- | ---------------------------------------------------- |
| `POST` | `/audit`  | Body `{ profile, url }` → audit JSON. Auth via `X-API-Key`. |
| `GET`  | `/health` | Liveness check → `{ ok: true }`.                     |
| `GET`  | `/`       | Local test console (HTML).                           |

The listing `url` host must be on the allow-list (`donedeal.ie`,
`autotrader.ie`, `autotrader.co.uk` by default — configurable via
`ALLOWED_LISTING_HOSTS`). Requests are rate-limited per client IP.

## Testing

```bash
bun test
```

## Deployment

The backend is stateless apart from an optional Postgres database used for price
tracking (set `DATABASE_URL`; tracking is disabled when unset). When running
behind a proxy or load balancer, set `TRUST_PROXY=true` so per-IP rate limiting
reads the real client IP from `X-Forwarded-For`.
