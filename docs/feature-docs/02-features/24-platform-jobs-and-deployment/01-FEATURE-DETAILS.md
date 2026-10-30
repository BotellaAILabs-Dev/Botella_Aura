# Platform: Jobs, Cron, Security & Deployment

> This is the infrastructure every other feature depends on. It covers: a background job queue that keeps long AI generations off the user's request and survives serverless timeouts; fourteen protected cron routes for scheduled work; the request layering (middleware → route → service → Prisma) with one error envelope; the shared outbound HTTP client; rate limiting, logging and error monitoring; token encryption and safe URL handling; an environment check at boot; security headers; four deployment targets; database diagnostics; a local stand-in for Meta (the sandbox); and the draft legal pages Meta requires.

## 1. Overview

| Area | What it provides | Main files |
| --- | --- | --- |
| Background jobs | `GenerationJob` queue: enqueue → client kicks the runner → poll. A cron reaper retries or fails stuck jobs. | `server/jobs/job.service.ts`, `server/jobs/runners.ts`, `app/api/jobs/**`, `app/api/cron/jobs/route.ts`, `components/dashboard/jobs/*` |
| Cron | 14 routes under `/api/cron/*`, each protected by `CRON_SECRET` | `app/api/cron/*/route.ts`, `lib/cron-auth.ts`, `vercel.json` |
| Request layering | Edge auth middleware, thin route handlers, service layer, Prisma singleton, one JSON error envelope | `middleware.ts`, `lib/auth-helpers.ts`, `lib/rbac.ts`, `lib/api.ts`, `lib/db.ts` |
| Outbound HTTP | Timeouts, retries on 5xx and network errors, URL redaction | `lib/http.ts` |
| Abuse and observability | In-memory rate limiter, structured JSON logger, Sentry-compatible error capture | `lib/rate-limit.ts`, `lib/logger.ts`, `lib/monitoring.ts` |
| Crypto and URL safety | AES-256-GCM, SHA-256, tokens, keyed hashes; http(s)-only links; same-site redirects | `lib/crypto.ts`, `lib/safe-url.ts` |
| Startup checks | Reports which integrations are configured, by variable name only | `instrumentation.ts`, `lib/env-check.ts`, `scripts/env-check.ts` |
| Security headers | Frame denial, nosniff, referrer policy | `next.config.mjs`, `netlify.toml` |
| Deployment | Vercel (with resilient migrations), Netlify, Railway, local Postgres via docker-compose | `vercel.json`, `scripts/migrate-deploy.mjs`, `netlify.toml`, `railway.json`, `docker-compose.yml`, `package.json` |
| Diagnostics | Database connection-string checker; OAuth endpoint printer | `scripts/check-db.mjs`, `scripts/auth-endpoints.ts` |
| Sandbox | WhatsApp, Facebook and Instagram against a local Meta stand-in | `scripts/sandbox.mjs`, `scripts/load/meta-stub.ts`, `lib/graph-base.ts`, `docs/SANDBOX.md` |
| Legal | Draft `/privacy`, `/terms`, `/data-deletion` | `app/privacy/page.tsx`, `app/terms/page.tsx`, `app/data-deletion/page.tsx`, `lib/legal.ts`, `components/legal/legal-page.tsx` |

## 2. User-facing behaviour

| Surface | Route | Behaviour | Who |
| --- | --- | --- | --- |
| Job indicator | App-wide in the dashboard (`components/dashboard/jobs/job-indicator.tsx`) | Shows every generation in flight for the workspace, and anything that finished in the last 5 minutes, so a job started on one page reports progress and completion from anywhere. Polls `/api/jobs/active` every 3 s while something runs, every 45 s when idle. | Any member |
| Job progress | Pages that start a job (`use-generation-job.ts`, `job-progress.tsx`) | Starting a job returns at once, and a progress bar follows `{ step, message, percent }`. Polls `GET /api/jobs/:id` every 1.5 s, for up to 400 polls (about 10 minutes). A reload reattaches through `GET /api/jobs?kind=`. | `content:create` to start; any member to read |
| Privacy Policy | `/privacy` | Public draft. Unknown facts appear as visible "to confirm" markers. `noindex` until `LEGAL.approved` is true. | Public |
| Terms of Service | `/terms` | Public draft: service, accounts, acceptable use, connected accounts, approval and publishing, content ownership, AI content, plans… | Public |
| Data Deletion | `/data-deletion` | How to delete Facebook/Instagram, LinkedIn, WhatsApp and whole-account data. | Public |
| Session expiry | any API call | An expired session returns 401 "Not signed in. Sign in again — your work on this page is kept." instead of 500. | — |

## 3. How it works

### 3.1 Request layering

1. **Edge middleware** (`middleware.ts`): `next-auth` `withAuth` on `/dashboard/:path*` and `/onboarding/:path*`. Requests without a valid session token are redirected to `/login` with a `callbackUrl`.
2. **Route handler** (`app/api/**/route.ts`): resolves the caller with `requireUser()`, `requireActiveCompany()`, `requireCompanyMembership()` or `requireCompanyRole()` (`lib/auth-helpers.ts`). Session and membership lookups are memoised per request with React `cache`. Permissions come from `can(role, permission)` / `assertCan()` (`lib/rbac.ts`):

   | Role | Permissions |
   | --- | --- |
   | OWNER | everything, including `company:delete` and `company:manageBilling` |
   | ADMIN | `company:update`, `members:invite`, `members:remove`, `linkedin:connect`, `content:create`, `content:approve`, `content:publish` |
   | MEMBER | `content:create` |
   | VIEWER | none (read-only) |

   Bodies are validated with zod. Routes return `jsonOk(data, status)`, `jsonError(message, status, details?)`, or `handleRouteError(error)`.
3. **Service** (`server/**`): business logic, always scoped by `companyId`.
4. **Prisma** (`lib/db.ts`): a singleton cached on `globalThis` outside production, so hot reload doesn't exhaust connections. Logging is `error` in production, `error`+`warn` in development, and adds `query` only with `PRISMA_LOG_QUERIES=1`.

`handleRouteError` (`lib/api.ts`) maps errors to responses:

| Error | Response |
| --- | --- |
| `ZodError` | 422 `Validation failed` + `details` (field errors) |
| `ForbiddenError` | 403 with its message |
| Next `redirect()` signal (digest `NEXT_REDIRECT…`) | 401 "Not signed in…" |
| AI provider failure (`aiFailureMessage`) | 503 with one plain message; captured |
| Any error with a numeric `status` | That status and message (+ `details`). ≥500 is captured. 409 with a `code` is logged as `route: refused`. |
| Anything else | 500 "Something went wrong. Please try again."; captured |

`getRequestMeta(req)` returns the IP (`x-forwarded-for`, then `x-real-ip`) and user agent for audit logs.

### 3.2 Background job queue

Job kinds (`GenerationJobKind`) and their runners in `server/jobs/runners.ts`:

| Kind | Runner |
| --- | --- |
| `TREND_DIGEST` | `generateDigestForCompany` |
| `MARKETING_PLAN` | `generateMarketingPlan`, which also records the creation on a recommendation when `recommendationId` is given |
| `INTELLIGENCE` | `generateIntelligenceSnapshot` |
| `IMAGE_GENERATION` | Graphics, variant refine/regenerate, or a marketing creative |
| `BRAND_VOICE_PREVIEW` | Kept out of the queue on purpose; its runner is a no-op so the enum stays exhaustive |

`POST /api/jobs` accepts only `TREND_DIGEST`, `MARKETING_PLAN` and `INTELLIGENCE`. Image jobs are enqueued by the graphics and creative routes.

Lifecycle (`server/jobs/job.service.ts`):

1. **`enqueueJob`**: inside a transaction, takes `pg_advisory_xact_lock(hashtext('job:<companyId>:<kind>:<dedupe>'))`, then looks for a `QUEUED`/`RUNNING` job of the same kind (narrowed by `dedupeOn`, for example `{ draftId }` for images).
   - If that job was active recently (latest of `createdAt` / `startedAt` / `updatedAt` within its fuse), it is reused. `inputsDiffer` tells the caller whether the new request asked for something different.
   - If it is past its fuse, it is failed with "Replaced by a new run." and a new job is created.
   - The route returns 201 for a new job and 200 for a reused one.
2. **The client kicks** `POST /api/jobs/:id/run` without awaiting it (`maxDuration = 60`, needs `content:create`), then polls.
3. **`claimJob`**: an atomic `QUEUED → RUNNING` (`updateMany` where `status = 'QUEUED'`), with `attempts + 1`. Only one caller wins, so a duplicate kick or a cron run is a no-op.
4. **`runJob`**: the runner reports progress through `reportProgress`, with percent clamped to 0–99.
5. **`completeJob`** → `SUCCEEDED` with `result`. **`failJob`** → back to `QUEUED` with "Hit a snag — retrying…" while `attempts < 3` (`MAX_ATTEMPTS`), unless the error declares `retryable === false`, which fails the job at once. Otherwise `FAILED`, with the error (up to 2000 chars) kept for the UI.
6. A failed job still answers the run request with 200 `{ ran: true, status: 'FAILED', error }`, because the job's own status carries the failure.

Fuses (`stuckAfterMs`): 10 min by default, 2 min for `MARKETING_PLAN`, 3 min for `IMAGE_GENERATION`. A `QUEUED` job is an orphan after 60 s (`ORPHAN_AFTER_MS`).

**The reaper** (`/api/cron/jobs`, `reapStuckJobs`):
- `RUNNING` jobs past their fuse go back to `QUEUED` ("Restarting…") if they have attempts left. Otherwise they become `FAILED` ("This run was interrupted and did not recover. Start it again.").
- It then runs up to 3 orphaned `QUEUED` jobs (`MAX_PER_SWEEP`), out of the 10 oldest it finds.
- Finally it deletes `SUCCEEDED`/`FAILED` jobs finished more than 7 days ago.

### 3.3 Cron routes

Every route exports `maxDuration = 60` and serves **GET and POST** with the same handler, because Vercel Cron sends GET. Each requires `Authorization: Bearer $CRON_SECRET` and fails closed (401) when `CRON_SECRET` is unset. `publish` and `whatsapp` compare in constant time (`timingSafeEqual`). The other twelve compare with `===`.

| Route | Work | Schedule in `vercel.json` | Schedule suggested in the route / VERCEL-DEPLOYMENT.md |
| --- | --- | --- | --- |
| `/api/cron/publish` | Scheduled publishes, Instagram processing, execution retries, Meta insights (45 s budget) | **`0 9 * * *`** | every 5–15 min (`docs/SCHEDULER.md`); `0,15,30,45 * * * *` on Pro |
| `/api/cron/briefing` | Weekly autopilot: writes and illustrates the week's posts, assembles the Monday briefing (`runAutopilot`, idempotent per company per week) | **`0 5 * * 1`** | `0 5 * * 1` |
| `/api/cron/connections` | Token refresh and connection health sweep (`runConnectionSweep`) | **`0 6 * * *`** | hourly `0 * * * *` |
| `/api/cron/jobs` | Job reaper | — | `*/5 * * * *` |
| `/api/cron/intelligence` | Daily Marketing Intelligence snapshot per workspace (upsert per company/day) | — | `0 5 * * *` |
| `/api/cron/campaigns` | Due campaign tasks → drafts (`executeDueCampaignTasks`); never publishes | — | `0 9 * * *` |
| `/api/cron/outreach` | Lead-signal detection (`detectForCompany`); drafts only | — | `0 12 * * *` |
| `/api/cron/trends` | Daily trend digest per company (`generateDigestForCompany`, trigger `scheduled`) | — | `0 13 * * *` |
| `/api/cron/advisor` | AI Marketing Advisor report (`generateAdvisorReport`) | — | `0 6 * * 1` |
| `/api/cron/analytics` | Weekly written analytics report (`generateAnalyticsReport`) | — | `0 8 * * 1` |
| `/api/cron/memory` | Weekly Marketing Memory extraction (`generateMemories`) | — | `0 10 * * 1` |
| `/api/cron/discovery` | Weekly lead discovery for `autoRun` profiles (`runDiscovery`) | — | `0 11 * * 1` |
| `/api/cron/competitors` | Weekly competitor tracking + report (`trackCompany`, `generateWeeklyReport`) | — | `0 13 * * 1` |
| `/api/cron/whatsapp` | WhatsApp queue sweep (`sweepQueue`); 503 when WhatsApp is not configured | — | every 1–5 min (`*/5 * * * *`) |

The per-company loops (trends, competitors, briefing and the others) run sequentially, and one failing workspace is logged and skipped. `vercel.json` ships three crons so the project deploys on the Hobby plan, which allows a limited number of daily crons. The other routes need a Pro plan (see [VERCEL-DEPLOYMENT.md](../../../VERCEL-DEPLOYMENT.md)) or an external scheduler that sends the same header.

### 3.4 Outbound HTTP (`lib/http.ts`)

- `httpRequest(url, { timeoutMs = 10_000, retries = 2 })`: an AbortController timeout per attempt. It retries network errors and 5xx with backoff of 250 ms, 500 ms, … (`250 * 2^attempt`, no jitter). 4xx, including 429, goes back to the caller.
- `getJson` / `getText` throw `HttpError(status, url, body≤500 chars)` on a non-2xx response.
- `redactUrl` masks `access_token`, `client_secret`, `appsecret_proof`, `fb_exchange_token`, `key`, `api_key` and `token` query parameters in error messages and logs.

### 3.5 Rate limiting (`lib/rate-limit.ts`)

`rateLimit(key, { limit, windowMs })` is a sliding window held in process memory. It returns `{ allowed, retryAfterSeconds, remaining }`, and prunes old keys when the map grows past 5000 entries. `clientIp(req)` reads proxy headers. Call sites include:

| Key | Limit |
| --- | --- |
| `forgot:<ip>` | 5 / min |
| `signup:<ip>` | 5 / min |
| `reset:<ip>` | 10 / min |
| `logo:<user>` | 10 / min |
| `graphic-generate:<user>` | 6 / min |
| `whatsapp-send:<user>` | 10 / min |
| `whatsapp-link-confirm:<user>` | 10 / 10 min |

There are also per-user limits on graphics, prompt, upload, variation, creative and `generate-image` routes, and per-company limits on `briefing-run`. Because the limiter is per instance, it is best-effort behind multiple serverless instances.

### 3.6 Logging and monitoring

- `logger.info|warn|error(message, context)` writes one JSON line: `{ level, message, context, time }`.
- `captureException(error, context)` always logs the message and stack. When `SENTRY_DSN` is set, it also sends a fire-and-forget event to Sentry's Store API (no SDK dependency).
- `instrumentation.ts` (enabled by `experimental.instrumentationHook`) runs `checkEnv` once at Node startup. It logs `environment: configuration` (info), or `environment: configuration problems` (error). It never stops the app.

### 3.7 Environment check (`lib/env-check.ts`)

Groups of variables. A group's status is `ready`, `off`, `partial`, or `missing_core` (core group only):

| Group | Required | Optional |
| --- | --- | --- |
| Core | `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ENCRYPTION_KEY` | `APP_URL`, `CRON_SECRET` |
| WhatsApp Cloud API | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_DISPLAY_NUMBER`, `WHATSAPP_WORKER_CONCURRENCY`, `WHATSAPP_QUICK_RETRY_MS`, `WHATSAPP_RETENTION_DAYS` |
| Meta login | `META_CLIENT_ID`, `META_CLIENT_SECRET` | `META_GRAPH_VERSION`, `META_OAUTH_PKCE`, `META_REQUEST_INSIGHTS`, `META_LOGIN_CONFIG_ID` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | `LINKEDIN_ORG_URN`, `LINKEDIN_OAUTH_PKCE`, `LINKEDIN_API_VERSION` |
| File storage (Instagram video) | `ASSET_S3_ENDPOINT`, `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY` | `ASSET_S3_REGION`, `ASSET_S3_PUBLIC_BASE_URL` |

**Errors**:
- missing core variables
- a partly configured group
- any `NEXT_PUBLIC_*` variable whose name looks secret (`SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|ACCESS_KEY|ENCRYPTION|DATABASE_URL`)
- an `ENCRYPTION_KEY` that is not 32 bytes in base64
- in production only: `APP_URL` or `NEXTAUTH_URL` on localhost, or `META_GRAPH_BASE_URL` / `WHATSAPP_GRAPH_BASE_URL` set at all

**Warnings**:
- a sandbox override set in development
- an invalid or year-old `LINKEDIN_API_VERSION`
- non-https URLs in production
- `CRON_SECRET` missing in production
- `APP_URL` and `NEXTAUTH_URL` on different hosts
- Meta configured while the app URL is localhost

`pnpm env:check [--production]` loads `.env` and `.env.local`, prints the same report and exits 1 on errors. Production at boot means `VERCEL_ENV === 'production'`, or `NODE_ENV === 'production'` with no `VERCEL_ENV`.

### 3.8 Crypto (`lib/crypto.ts`)

- `encrypt` / `decrypt`: AES-256-GCM with a 12-byte random IV. Stored as `base64(iv).base64(tag).base64(ciphertext)`. The key is `ENCRYPTION_KEY` (32 bytes, base64), validated lazily: the app boots without it, but encrypting fails loudly.
- `sha256(input)`: used for single-use reset-token lookup.
- `generateToken(bytes = 32)`: base64url random tokens.
- `keyedHash(value, purpose)`: HMAC-SHA256 with `ENCRYPTION_KEY`, a stable lookup key for encrypted values such as WhatsApp numbers.
- `lib/cron-auth.ts` uses `crypto.timingSafeEqual`.

### 3.9 Safe URLs (`lib/safe-url.ts`, client-safe)

- `safeExternalUrl(raw)` returns the URL only for `http:` or `https:`, otherwise `null`, so third-party feed links can never become a `javascript:` href. It is used by trend stories, competitor news and AI-cited evidence.
- `isWebUrl(raw)`: a boolean form of the same check, for validation.
- `safeRedirectPath(raw, fallback)`: accepts only a path starting with a single `/`. It rejects `//host`, backslashes and control characters, which prevents an open redirect through `?callbackUrl=`.

### 3.10 Security headers (`next.config.mjs`)

| Header | Value | Source |
| --- | --- | --- |
| `X-Frame-Options` | `DENY` (clickjacking protection for Approve/Publish) | `next.config.mjs`, all paths |
| `X-Content-Type-Options` | `nosniff` | `next.config.mjs` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | `next.config.mjs` |
| `X-Powered-By` | removed (`poweredByHeader: false`) | `next.config.mjs` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | `netlify.toml` only |
| `X-Frame-Options` | `SAMEORIGIN` | `netlify.toml`. This conflicts with the `DENY` in `next.config.mjs`. |

Other settings in `next.config.mjs`:
- `staleTimes` of 30 s for dynamic pages and 180 s for static, matching the TanStack Query `staleTime`
- `serverComponentsExternalPackages: ['@resvg/resvg-js']`, with `./assets/fonts/**` traced into `/api` and `/dashboard` functions
- `optimizePackageImports` for the Radix packages
- an image `minimumCacheTTL` of 30 days, and `remotePatterns` open to any https host (a known open-proxy tradeoff, noted in the file)

### 3.11 Deployment targets

| Target | Config | Build / start | Notes |
| --- | --- | --- | --- |
| **Vercel** | `vercel.json` (region `sin1`, 3 crons) | `pnpm run vercel-build` = package extension → `prisma generate` → `DIRECT_URL=${DIRECT_URL:-$DATABASE_URL} node scripts/migrate-deploy.mjs` → `next build` | All routes cap `maxDuration` at 60 s |
| **Netlify** | `netlify.toml` (`@netlify/plugin-nextjs`, publish `.next`, Node 20) | `pnpm run netlify:build` = package extension → `prisma generate` → `prisma migrate deploy` → `next build` | No SPA redirect, and no `output: 'export'`: the app is server-rendered. `SECRETS_SCAN_OMIT_KEYS` lists the public defaults. `/_next/static/*` is cached for a year. |
| **Railway** | `railway.json` (Nixpacks) | start `pnpm run start:prod` = `prisma migrate deploy && next start` | Restarts `ON_FAILURE`, up to 3 retries |
| **Local DB** | `docker-compose.yml` | `docker compose up -d` | `postgres:16-alpine`, container `botella-aura-db`, user/password `postgres`, DB `botella_aura`, port 5432, healthcheck `pg_isready` |

`prisma/schema.prisma` declares `binaryTargets = ["native", "rhel-openssl-3.0.x"]` (the serverless Lambda engine) and `directUrl = env("DIRECT_URL")`. `package.json` requires Node `>=20`, and `postinstall` runs `prisma generate`.

**`scripts/migrate-deploy.mjs`** runs `npx prisma migrate deploy` up to 5 times:
- A connection failure (`P1001`, `P1002`, `P1017`) is retried with exponential backoff from 2 s.
- Any other migration error fails the build at once.
- If every attempt is a connection failure, the build fails, unless `ALLOW_DEPLOY_WITHOUT_MIGRATIONS=1`. In that case it warns loudly and continues, and the migrations must then be run by hand with `pnpm db:migrate:deploy`.

### 3.12 `scripts/check-db.mjs`

Run it with `CHECK_DB_URL="<url>" node scripts/check-db.mjs` (or pass the URL as an argument). It prints the host, port, database and `sslmode` (never the password), warns about pasted quotes or whitespace, then tests four layers and stops at the first failure:

1. DNS lookup
2. TCP connect (10 s timeout)
3. TLS `SSLRequest` + Postgres startup packet (15 s). A server that asks for a password means the endpoint is live. Plaintext fallback for a local Postgres.
4. A verdict: if every layer passed but the deployment still fails with P1001, the build network is blocked (Neon IP Allow). It also suggests `sslmode=require` when that is missing.

### 3.13 The Meta sandbox (`docs/SANDBOX.md`)

| Command | What it does |
| --- | --- |
| `pnpm sandbox` (also `pnpm whatsapp:local`) | Starts the Meta stand-in (`scripts/load/meta-stub.ts`) on `http://localhost:4010` (`STUB_PORT`) and the app on `http://localhost:3001` (`SANDBOX_PORT`), wired together |
| `pnpm sandbox check` | Runs `scripts/verify-sandbox.ts` and the WhatsApp loop |
| `pnpm sandbox say "<message>"` | Sends a WhatsApp message and shows the reply |
| `pnpm sandbox script` | The scripted demo conversation |

- The demo login is `demo@botella.ai` / `Password123`.
- Database URLs get a bounded `connection_limit` and `pool_timeout=30`, so two servers don't exhaust a local Postgres.
- Only Meta is replaced. Webhook signatures, the queue and worker, routing, the approval gate, the publishers and Instagram's container polling are all real.
- `META_GRAPH_BASE_URL` and `WHATSAPP_GRAPH_BASE_URL` are honoured only for loopback hosts (`lib/graph-base.ts`). `env:check` warns about them in development and errors in production.
- Stub knobs: `STUB_ERROR_RATE` (0.02), `STUB_META_ERROR_RATE` (0), `STUB_IG_PROCESSING_MS` (1200), `STUB_PAGE_ID` / `STUB_PAGE_NAME`, `STUB_IG_USER_ID` / `STUB_IG_USERNAME`, `STUB_GRANTED_SCOPES`.
- The sandbox does not prove that Meta accepts the traffic.

### 3.14 Legal pages

`lib/legal.ts` holds the facts the pages depend on: `approved: false`, `productName: 'Botella Aura'`, and `null` for the operator's legal name, address, privacy and support emails, effective date, governing law, minimum age, retention after closure and hosting. Each `null` is shown as a "to confirm" marker (`Confirm`, `Fact` in `components/legal/legal-page.tsx`), and `operatorName()` falls back to "Botella AI Labs". While `approved` is false, each page sets `robots: { index: false, follow: false }` and shows a draft banner. `/data-deletion` is the user-facing explanation. Meta's machine callback is `POST /api/meta/data-deletion`, with a status page at `/meta/data-deletion` (see feature 19).

### 3.15 Other scripts

- `pnpm auth:endpoints [port|host|url]` prints every OAuth redirect URI and webhook URL to register for a base URL (`server/oauth/endpoints.ts`). It prints variable names only.
- `pnpm db:rehearse` runs `scripts/migration-rehearsal.ts`.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Middleware | `middleware.ts` | Session guard for `/dashboard`, `/onboarding` |
| Instrumentation | `instrumentation.ts` | Boot-time env report |
| API | `app/api/jobs/route.ts` | Enqueue (POST), latest job of a kind (GET) |
| API | `app/api/jobs/[id]/route.ts` | Poll one job |
| API | `app/api/jobs/[id]/run/route.ts` | Execute a queued job |
| API | `app/api/jobs/active/route.ts` | Jobs in flight + finished in the last 5 min (max 10) |
| API | `app/api/cron/*/route.ts` (14) | Scheduled jobs |
| Service | `server/jobs/job.service.ts` | Enqueue/dedupe, claim, progress, complete, fail, reap |
| Service | `server/jobs/runners.ts` | Work per job kind |
| Component | `components/dashboard/jobs/job-indicator.tsx`, `job-progress.tsx`, `use-generation-job.ts` | App-wide indicator, progress UI, polling hook |
| Lib | `lib/api.ts` | JSON envelope, error mapping, request meta |
| Lib | `lib/auth-helpers.ts`, `lib/rbac.ts` | Session, membership, permissions |
| Lib | `lib/db.ts` | Prisma singleton |
| Lib | `lib/http.ts` | Outbound HTTP client |
| Lib | `lib/cron-auth.ts` | Constant-time cron bearer check |
| Lib | `lib/rate-limit.ts` | Sliding-window limiter |
| Lib | `lib/logger.ts`, `lib/monitoring.ts` | Structured logs, error capture, Sentry |
| Lib | `lib/crypto.ts` | Encryption, hashing, tokens |
| Lib | `lib/safe-url.ts` | Link and redirect safety |
| Lib | `lib/env-check.ts` | Env groups and rules |
| Lib | `lib/graph-base.ts` | Loopback-only Graph override |
| Lib | `lib/legal.ts` | Legal facts |
| Page | `app/privacy/page.tsx`, `app/terms/page.tsx`, `app/data-deletion/page.tsx` | Draft legal pages |
| Config | `next.config.mjs`, `vercel.json`, `netlify.toml`, `railway.json`, `docker-compose.yml`, `package.json`, `prisma/schema.prisma` | Build, headers, deploy, crons |
| Script | `scripts/migrate-deploy.mjs`, `scripts/check-db.mjs`, `scripts/env-check.ts`, `scripts/auth-endpoints.ts`, `scripts/sandbox.mjs` | Deploy and diagnostics tooling |
| Tests | `tests/job-dedupe.test.ts`, `tests/job-permanent-failure.test.ts`, `tests/env-check.test.ts`, `tests/crypto.test.ts`, `tests/security-fixes.test.ts`, `tests/safe-links-render.test.tsx`, `tests/graph-base.test.ts`, `tests/request-body.test.ts`, `tests/scheduler.test.ts`, `tests/tenant-isolation.test.ts`, `tests/data-access-security.test.ts` | Unit coverage |

## 5. Data model

| Model / enum | Key fields | Notes |
| --- | --- | --- |
| `GenerationJob` | `id`, `companyId`, `userId`, `kind`, `status` (default `QUEUED`), `inputs` (JSON, replayed on retry), `progress` (JSON `{ step, message, percent }`), `result` (JSON), `error` (text, shown to the user), `attempts`, `startedAt`, `finishedAt`, `createdAt`, `updatedAt` | Cascade-deleted with `Company`. Indexes (`companyId`, `kind`, `status`) and (`status`, `createdAt`). |
| `GenerationJobKind` | `TREND_DIGEST`, `MARKETING_PLAN`, `INTELLIGENCE`, `BRAND_VOICE_PREVIEW`, `IMAGE_GENERATION` | |
| `GenerationJobStatus` | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED` | |
| Schema as a whole | 61 models, 50 migrations in `prisma/migrations` | PostgreSQL. `directUrl` for migrations. |

## 6. API endpoints

Full list: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| POST | `/api/jobs` `{ kind, inputs? }` | Queue `TREND_DIGEST` / `MARKETING_PLAN` / `INTELLIGENCE`. 201 new, 200 reused. | `content:create` |
| GET | `/api/jobs?kind=` | Latest job of a kind | Any member |
| GET | `/api/jobs/:id` | Poll one job (scoped to the workspace, 404 otherwise) | Any member |
| POST | `/api/jobs/:id/run` | Claim and run | `content:create` |
| GET | `/api/jobs/active` | In-flight + recently finished jobs | Any member |
| GET / POST | `/api/cron/{publish,briefing,connections,jobs,intelligence,campaigns,outreach,trends,advisor,analytics,memory,discovery,competitors,whatsapp}` | Scheduled jobs | `Authorization: Bearer $CRON_SECRET` |

## 7. External services

| Service | Used by | Env vars |
| --- | --- | --- |
| Sentry Store API | `lib/monitoring.ts` (optional) | `SENTRY_DSN` |
| PostgreSQL (Neon or any provider) | Prisma | `DATABASE_URL`, `DIRECT_URL`, `PRISMA_LOG_QUERIES` |
| Vercel Cron | `vercel.json` | `CRON_SECRET` |
| Hosting platforms | Vercel, Netlify, Railway | `VERCEL_ENV`, `ALLOW_DEPLOY_WITHOUT_MIGRATIONS` |

See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

Covered in §3.2 (queue and reaper) and §3.3 (all 14 cron routes and their schedules). In short:
- `vercel.json` runs `publish` (`0 9 * * *`), `briefing` (`0 5 * * 1`) and `connections` (`0 6 * * *`).
- Every other route needs a Pro-plan cron or an external scheduler.
- Generation does not depend on the cron: the browser kicks `/api/jobs/:id/run` itself, and `/api/cron/jobs` is only the safety net.

## 9. Security & permissions

- Defence in depth: edge middleware for pages, then `requireUser` / `requireActiveCompany` and RBAC in every route and Server Component.
- Workspace scoping: jobs are read with `findFirst({ id, companyId })`. The advisory lock key includes the company.
- Cron routes fail closed without `CRON_SECRET`.
- Secrets: AES-256-GCM at rest. Errors and logs redact credential query parameters. `env:check` flags secret-looking `NEXT_PUBLIC_*` variables. The env report contains names only.
- Clickjacking: `X-Frame-Options: DENY`. MIME sniffing: `nosniff`.
- XSS through links: `safeExternalUrl`. Open redirect: `safeRedirectPath`.
- Brute force: per-IP limits on signup, forgot-password and reset.
- Errors never leak internals: unknown errors return a generic 500 and are captured.

## 10. Testing

| Test | Covers |
| --- | --- |
| `tests/job-dedupe.test.ts` (9) | `enqueueJob` reuse, dedupe scope, `inputsDiffer` |
| `tests/job-permanent-failure.test.ts` (5) | `failJob` permanent vs transient |
| `tests/env-check.test.ts` (8) | Groups, partial config, exposed secrets, production rules |
| `tests/crypto.test.ts` (5) | Encryption round trip and failures |
| `tests/security-fixes.test.ts` (6) | Post-login redirect, extension mark-published, campaign creation |
| `tests/safe-links-render.test.tsx` (2) | Trend story links render only http(s) |
| `tests/graph-base.test.ts` | Loopback-only override |
| `tests/request-body.test.ts` (4) | Request body is single-use |
| `tests/scheduler.test.ts` (8) | `CRON_SECRET` authentication, scheduler selection |
| `tests/tenant-isolation.test.ts`, `tests/data-access-security.test.ts` | Workspace isolation |

Scripts: `pnpm test` (Vitest), `pnpm typecheck`, `pnpm lint`, `pnpm env:check`, `pnpm verify:sandbox`, `pnpm verify:access`, `pnpm verify:permissions`, `pnpm verify:scheduler`, `pnpm load:meta-stub`, `pnpm load:whatsapp`.

## 11. Configuration & limits

| Setting | Value |
| --- | --- |
| Job fuse | 10 min default, 2 min `MARKETING_PLAN`, 3 min `IMAGE_GENERATION` |
| Orphan queued job | 60 s |
| Job attempts | 3 |
| Reaper per sweep | 3 run (of 10 found) |
| Finished job retention | 7 days |
| Recently finished window (`/api/jobs/active`) | 5 min, max 10 jobs |
| Client polling | 1.5 s per job (max 400 polls); indicator 3 s active / 45 s idle |
| Function `maxDuration` | 60 s for every cron and the job runner |
| HTTP client | 10 s timeout, 2 retries, 250 ms × 2^n backoff |
| Rate limiter map cleanup | over 5000 keys |
| Error body kept | 500 chars (`HttpError`), 2000 chars (job error) |
| Router cache | 30 s dynamic, 180 s static |
| Image cache TTL | 30 days |
| Vercel region | `sin1` |
| Migration retries | 5, from 2 s exponential |

## 12. Known limitations & future work

- The rate limiter is per instance. The documented upgrade is a shared store (Upstash/Redis) behind the same `rateLimit()` interface.
- Monitoring uses Sentry's Store API directly. `@sentry/nextjs` could replace it behind `captureException`.
- The logger writes JSON to the console. A real sink (Pino, Datadog) would replace `emit`.
- Twelve cron routes compare `CRON_SECRET` with `===` instead of `isCronAuthorized` (constant time).
- `vercel.json` ships 3 crons. The job reaper, the WhatsApp sweep and the daily and weekly AI jobs don't run until a Pro plan or an external scheduler is set up, and publishing happens once a day.
- `/_next/image` accepts any https host (`remotePatterns: '**'`), which makes it an open image proxy. The file suggests copying logos into blob storage.
- The legal pages are drafts (`LEGAL.approved = false`), with operator facts still to confirm.
- Netlify's `netlify:build` runs plain `prisma migrate deploy`, without the retry wrapper Vercel uses.

## 13. Related documents

- [VERCEL-DEPLOYMENT.md](../../../VERCEL-DEPLOYMENT.md), [DEPLOYMENT-CHECKLIST.md](../../../DEPLOYMENT-CHECKLIST.md), [DEPLOYMENT-ENV.md](../../../DEPLOYMENT-ENV.md), [PRODUCTION-MIGRATION.md](../../../PRODUCTION-MIGRATION.md)
- [SCHEDULER.md](../../../SCHEDULER.md), [SANDBOX.md](../../../SANDBOX.md), [AUTH-SETUP.md](../../../AUTH-SETUP.md), [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md), [SPRINT-6-TECHNICAL.md](../../../SPRINT-6-TECHNICAL.md)
- Sibling features: [19-connections-and-connectors](../19-connections-and-connectors/01-FEATURE-DETAILS.md), [20-publishing-execution-and-scheduling](../20-publishing-execution-and-scheduling/01-FEATURE-DETAILS.md), [21-whatsapp-assistant](../21-whatsapp-assistant/01-FEATURE-DETAILS.md), [01-authentication-and-accounts](../01-authentication-and-accounts/01-FEATURE-DETAILS.md), [02-workspaces-team-and-roles](../02-workspaces-team-and-roles/01-FEATURE-DETAILS.md)
