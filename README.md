# Botella Aura — AI Marketing Co-Pilot

> **Sprint 1: Foundation.** Auth, company onboarding, a production-grade
> dashboard shell, and a schema designed for the full 10-sprint roadmap.

Botella Aura researches trends, analyzes companies, generates on-brand content,
and drafts outreach — with a **human-in-the-loop approval step before anything
goes live**. Nothing auto-posts, auto-connects, or auto-comments. Ever.

---

## Quick start (under 10 minutes)

**Prerequisites:** Node ≥ 20, [pnpm](https://pnpm.io) ≥ 9, and a PostgreSQL
database. No local Postgres? Use the bundled Docker setup (step 2).

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres (optional — skip if you have your own)
docker compose up -d

# 3. Configure environment
cp .env.example .env
#   → then generate the two secrets (see “Environment variables” below)

# 4. Create the schema and seed a demo workspace
pnpm db:migrate       # applies prisma/migrations
pnpm db:seed          # creates the demo user + company

# 5. Run it
pnpm dev              # → http://localhost:3000
```

**Demo login:** `demo@botella.ai` / `Password123`

That's the whole loop: sign up, complete onboarding, land in the dashboard.

---

## Environment variables

Every variable is documented in [`.env.example`](.env.example). The two you
**must** generate locally:

```bash
# NEXTAUTH_SECRET — signs session JWTs
openssl rand -base64 32

# ENCRYPTION_KEY — AES-256-GCM key for tokens at rest (must be 32 bytes)
openssl rand -base64 32
```

| Variable                              | Required           | Purpose                                            |
| ------------------------------------- | ------------------ | -------------------------------------------------- |
| `DATABASE_URL`                        | ✅                 | PostgreSQL connection string                       |
| `NEXTAUTH_URL`                        | ✅                 | App base URL (`http://localhost:3000` in dev)      |
| `NEXTAUTH_SECRET`                     | ✅                 | Session/JWT signing secret                         |
| `ENCRYPTION_KEY`                      | ✅                 | Encrypts sensitive tokens at rest                  |
| `GOOGLE_CLIENT_ID` / `_SECRET`        | Optional           | Enables **Continue with Google**                   |
| `ANTHROPIC_API_KEY`                   | Sprint 2 (AI)      | Powers trend-digest AI; without it, digests use basic non-AI summaries |
| `LINKEDIN_CLIENT_ID` / `_SECRET`      | Sprint 2 (opt.)    | Enables **Connect LinkedIn** (official OIDC)       |
| `REDDIT_CLIENT_ID` / `_SECRET` / `_USER_AGENT` | Sprint 2 (opt.) | Enables the Reddit trend source          |
| `TWITTER_BEARER_TOKEN`                | Sprint 2 (opt.)    | Enables the X/Twitter trend source (off by default)|
| `CRON_SECRET`                         | Sprint 2           | Protects the scheduled digest endpoint             |
| `RESEND_*`                            | Later sprint       | Real email delivery (console stub until then)      |

Hacker News and Google News trend sources need **no credentials**.

### Sprint 2 — LinkedIn + Trend Intelligence

**Get the API keys** (see [`.env.example`](.env.example) for exact var names):

| Provider | Where | Notes |
| --- | --- | --- |
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com) → API Keys | Powers "why this matters" + suggested angles. Model: `claude-opus-4-8`. |
| LinkedIn | [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) | Add product **"Sign In with LinkedIn using OpenID Connect"**; redirect URL `http://localhost:3000/api/linkedin/callback`. |
| Reddit | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) | Create a **script** app; read-only app-only token. Set a descriptive `REDDIT_USER_AGENT`. |

**Run the daily digest job** — a protected endpoint (`POST /api/cron/trends`), platform-agnostic so any scheduler works:

```bash
# Manual / local:
curl -X POST http://localhost:3000/api/cron/trends -H "authorization: Bearer $CRON_SECRET"
# Vercel Cron (vercel.json): { "crons": [{ "path": "/api/cron/trends", "schedule": "0 13 * * *" }] }
```

Users can also click **Refresh** in the dashboard. Digests are idempotent per
company per day (upsert on `companyId + date`).

**LinkedIn scope reality:** we integrate only against the self-serve OIDC
product (scopes `openid profile email`) for basic profile data. The public feed
and posting are **not** available through LinkedIn's API without Marketing
Developer Platform / Community Management approval — those are stubbed and
flagged in code, never faked. No scraping, no unofficial endpoints, ever.

### Enabling Google OAuth

1. Create an OAuth client at
   [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Add the redirect URI: `http://localhost:3000/api/auth/callback/google`
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

The Google button only renders when both variables are present, so the app runs
fine without it.

### Sprint 4 — Competitors · Extension · Outreach · Engagement

Four modules, all built on the product's core safety principle: **every LinkedIn
action is performed by a real human clicking in their own browser via the
extension. The backend never touches linkedin.com.**

**1. Competitor Intelligence** (`/dashboard/competitors`) — track competitors
from public signal only: website change detection (robots-respecting fetch +
diff, Claude-summarized), public news/RSS, and GitHub public API. Weekly AI
report at `/dashboard/competitors/reports`. The LinkedIn company-page feed is a
flagged stub (no official scope — no scraping).

**2. Chrome Extension** (`/extension`) — the action layer. Load it unpacked
(`chrome://extensions` → Developer mode → Load unpacked → select `extension/`),
then pair it from **Settings → Browser extension**. It shows a queue of approved
items; you insert each into LinkedIn's own composer and click Post yourself.
Auth is a separate, revocable, workspace-scoped bearer token (only its SHA-256
hash is stored). See [`extension/README.md`](extension/README.md).

**3. Outreach Intelligence** (`/dashboard/outreach`) — detect leads from public
signal (GitHub, news, hiring RSS; Crunchbase optional behind a key), AI-draft
brand-voice-grounded connection notes + follow-ups, approve them, and send from
the extension. Configure targeting at `/dashboard/settings/outreach`.

**4. Engagement Copilot** (`/dashboard/engagement`) — the extension offers to
draft an on-brand comment on posts **already visible on your screen**; the post
text is captured client-side and sent up — there is no server-side LinkedIn
fetch. The web app is the read-only record. Choose monitored profiles at
`/dashboard/settings/engagement`.

**New env (all optional):** `GITHUB_TOKEN` (higher rate limit),
`CRUNCHBASE_API_KEY` (funding signals), `EXTENSION_ALLOWED_ORIGIN` (pin a
published extension in prod). See [`.env.example`](.env.example).

**New scheduled jobs** (protected by `CRON_SECRET`, platform-agnostic):

```bash
curl -X POST http://localhost:3000/api/cron/competitors -H "authorization: Bearer $CRON_SECRET"  # weekly
curl -X POST http://localhost:3000/api/cron/outreach     -H "authorization: Bearer $CRON_SECRET"  # daily
```

Nothing in Sprint 4 sends, posts, or connects without an explicit human click in
the extension — every action is audited in `AuditLog`.

### Sprint 5 — Lead Discovery + Marketing Memory

Two modules that make Aura compound in value the longer it's used.

**Lead Discovery Engine** (`/dashboard/leads`, `/dashboard/leads/discover`) —
proactive prospecting. Define a `DiscoveryProfile` (industry, stage, role titles,
geography, keywords); discovery searches **legitimate public sources** (GitHub
org search + robots-gated company team pages that actually run keyless;
Crunchbase + Google Custom Search behind optional keys) to build an AI-scored
lead list. Discovered leads are **deduped against existing signal leads** (never
a duplicate row) and flow into the Sprint 4 outreach pipeline via "Draft
outreach" — no parallel pipeline. Optional weekly auto-run.

**Marketing Memory / Learning Loop** (`/dashboard/memory`) — the product
remembers what works. Real performance data is captured honestly: the extension
syncs the like/comment counts already visible on **your own** post page (no
server-side LinkedIn fetch), and outreach outcomes are a manual toggle. A weekly
job extracts data-grounded `MarketingMemory` insights — and honestly returns
**"not enough data yet"** below 10 measured posts rather than inventing any. Those
insights are **injected into the content + outreach generators**, so drafts get
smarter every week. The dashboard shows insight cards (with the data behind
each), an engagement trend chart, and best/worst posts. **No metric or insight is
ever fabricated.**

**New env (all optional):** `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` (web-search
discovery). Reuses `GITHUB_TOKEN` / `CRUNCHBASE_API_KEY`. See
[`.env.example`](.env.example).

**New scheduled jobs** (protected by `CRON_SECRET`):

```bash
curl -X POST http://localhost:3000/api/cron/discovery -H "authorization: Bearer $CRON_SECRET"  # weekly
curl -X POST http://localhost:3000/api/cron/memory     -H "authorization: Bearer $CRON_SECRET"  # weekly
```

### Sprint 6 — Campaigns · Analytics · Billing · Launch (final MVP)

- **Campaign Orchestrator** (`/dashboard/campaigns`) — one goal → an AI-planned,
  Zod-validated 30-day schedule. A daily cron **conducts** the existing pipelines
  (content/outreach/discovery), landing everything in the normal approval queues.
  **Nothing publishes or sends without per-item human approval** — verified.
- **Analytics** (`/dashboard/analytics`) — top-line metrics, engagement trend,
  outreach funnel, channel breakdown, and a copyable weekly written report — all
  from real data, with honest empty states.
- **Billing (Stripe)** (`/dashboard/settings/billing`) — hosted Checkout + Customer
  Portal, **signature-verified webhooks**, plan-based entitlements, and a 14-day
  trial that degrades to read-only (never a data-losing lockout). Set the Stripe
  keys + price IDs to enable (see checklist below).
- **Production hardening** — multi-tenant isolation tests, auth rate limiting,
  `captureException` monitoring (Sentry-ready), and a marketing landing page.

New scheduled jobs (same `CRON_SECRET`): `/api/cron/campaigns` (daily),
`/api/cron/analytics` (weekly).

---

## Production deployment & secrets checklist

The app is a single Next.js deployable (this repo ships a `netlify.toml`; Vercel
works too). All scheduled jobs are **platform-agnostic HTTP endpoints** under
`/api/cron/*`, protected by `CRON_SECRET` — wire them to any scheduler (Vercel
Cron, Netlify Scheduled Functions, GitHub Actions, cron-job.org) that can `POST`
with an `Authorization: Bearer $CRON_SECRET` header. Suggested cadence:

| Endpoint | Cadence |
|---|---|
| `/api/cron/trends` | daily |
| `/api/cron/publish` | every 15 min (scheduled content) |
| `/api/cron/campaigns` | daily |
| `/api/cron/outreach` · `/api/cron/discovery` | daily / weekly |
| `/api/cron/competitors` · `/api/cron/memory` · `/api/cron/analytics` | weekly |

### Required secrets

| Secret | Purpose |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Postgres (pooled runtime / direct for migrations) |
| `NEXTAUTH_URL` / `NEXTAUTH_SECRET` | Auth base URL + JWT signing |
| `ENCRYPTION_KEY` | AES-256-GCM key for tokens at rest (32 bytes base64) |
| `CRON_SECRET` | Protects every `/api/cron/*` job |

### Optional (features degrade honestly without them)

| Secret | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | All AI generation (fallbacks otherwise) |
| `GOOGLE_CLIENT_ID/_SECRET` | Google sign-in |
| `LINKEDIN_CLIENT_ID/_SECRET` | LinkedIn Connect (official OIDC) |
| `GITHUB_TOKEN`, `CRUNCHBASE_API_KEY`, `GOOGLE_CSE_API_KEY`+`_CX`, `REDDIT_*`, `TWITTER_BEARER_TOKEN` | Trend/competitor/lead sources |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/_GROWTH/_AGENCY` | Billing |
| `SENTRY_DSN` | Error monitoring |
| `EXTENSION_ALLOWED_ORIGIN` | Pin the published Chrome extension origin |

**Before go-live:** run `pnpm db:migrate:deploy` (chain verified to apply on a
fresh DB), set the Stripe webhook endpoint to `/api/webhooks/stripe` with its
signing secret, and wire the cron endpoints to your scheduler.

---

## Scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Start the dev server                                |
| `pnpm build`        | Production build (runs `prisma generate` first)     |
| `pnpm start`        | Serve the production build                           |
| `pnpm lint`         | ESLint                                              |
| `pnpm typecheck`    | `tsc --noEmit` (strict)                             |
| `pnpm test`         | Vitest unit tests                                   |
| `pnpm format`       | Prettier write                                      |
| `pnpm db:migrate`   | Apply migrations (dev)                              |
| `pnpm db:seed`      | Seed demo user + company                            |
| `pnpm db:studio`    | Open Prisma Studio                                  |

---

## Architecture

### Why this stack

- **Next.js 14 App Router (single app, API routes)** — one deployable unit and
  shared Zod schemas/types across client and server. A separate backend service
  would add ops overhead with no Sprint-1 benefit. If a heavy async workload
  appears later (e.g. trend crawling), it can be split into its own worker
  without touching this app's boundaries.
- **NextAuth v4** — stable and production-proven. New OAuth providers (LinkedIn
  in Sprint 2) are added as one entry in `lib/auth.ts`; the `Account` table
  already models arbitrary providers, so **no schema change** is needed.
- **Prisma + PostgreSQL** — typed data access; the schema is designed up front
  for all 10 sprints to avoid painful migrations.
- **bcryptjs** — pure-JS, so no native build step on Windows/CI.

### Folder structure

```
app/
  (auth)/            login, signup, forgot/reset-password  (route group)
  dashboard/         protected shell + overview, settings, feature placeholders
  onboarding/        post-signup wizard
  api/               validated route handlers (auth, companies)
  layout.tsx         root layout + providers
components/
  ui/                design-system primitives (Button, Card, Dialog, Badge, …)
  auth/              login/signup/reset forms
  onboarding/        multi-step wizard
  dashboard/         sidebar, topbar, company switcher, settings forms
  brand/             logo
lib/
  db.ts              Prisma client singleton
  auth.ts            NextAuth config (providers, callbacks, audit events)
  auth-helpers.ts    server-side session + company RBAC guards
  password.ts        bcrypt hash/verify
  crypto.ts          AES-256-GCM (tokens at rest) + reset-token hashing
  rbac.ts            role → permission matrix (can / assertCan)
  validations/       Zod schemas (single source of truth: client + server + tests)
  email.ts           transport abstraction (console in Sprint 1)
  api.ts             consistent JSON responses + error mapping
  nav.ts             single source of truth for sidebar/roadmap
server/
  services/          business logic, kept OUT of route handlers
    user, company, audit, auth-token
prisma/
  schema.prisma      full 10-sprint data model
  migrations/        committed SQL migrations
  seed.ts            demo data
types/               shared types + NextAuth session augmentation
tests/               Vitest (password, crypto, validations, company service)
middleware.ts        edge auth guard for /dashboard/* and /onboarding
```

### Request flow (defense in depth)

1. **Edge middleware** (`middleware.ts`) redirects unauthenticated users away
   from `/dashboard/*` and `/onboarding` before any code runs.
2. **API routes** validate every input with **Zod** before touching the DB, and
   enforce **company-scoped RBAC** (`requireCompanyRole`) where relevant.
3. **Services** (`server/services`) own all writes and wrap
   action + audit-log in a single Prisma transaction.

### Trust & safety: the audit trail

Every meaningful business action — signup, login, company creation, settings
updates (and, in later sprints, every AI suggestion / approval / publish) —
writes a typed `AuditLog` entry via `recordAudit()`. This is a product
principle (transparency + a future explainability feature), not an add-on.
Audit writes never break the primary action: a logging failure is recorded and
swallowed.

---

## Data model highlights

- **Multi-tenant from day one:** `Company` + `CompanyMember` join, so a user can
  belong to multiple workspaces with a per-company role (drives the topbar
  switcher and RBAC).
- **`Company.preferences (Json)`** — extensible bag for onboarding/AI-prompt
  signals alongside explicit columns, so later sprints add data without a
  migration.
- **Sprint 2–10 tables scaffolded now:** `LinkedInConnection` (encrypted token
  columns), `ContentDraft` (approval lifecycle enum), `TrendDigest`,
  `CompetitorProfile`. See inline comments in `prisma/schema.prisma`.

---

## Shipped in Sprint 3

- **Content Studio** — the flagship. Knowledge-base ingestion
  (`server/knowledge/`: website with **robots.txt** compliance + throttling,
  blog/RSS, and `.txt`/`.md`/`.pdf` uploads via `unpdf`), chunking + a
  keyword/recency **retrieval** function, an AI-analyzed **Brand Voice Profile**
  (human-editable) injected into every generation, and a Claude-powered
  **generator** for LinkedIn posts, carousels, X threads, and blog drafts —
  every output validated against a strict per-type Zod schema (retry-once).
- **Approval queue** (`/dashboard/content`) — kanban by status, detail editor
  with per-type preview, Refine/Regenerate, bulk actions, and a **state machine
  that makes PUBLISHED reachable only from APPROVED** (enforced in the service
  layer — no code path publishes an unapproved draft).
- **Publishing** — official LinkedIn Company Page API wired (`/rest/posts`),
  honestly **scope-gated**: until Community Management API approval +
  `w_organization_social` + `LINKEDIN_ORG_URN` exist, every type uses the
  **"copy for manual posting"** fallback (never a fake published state).
  Scheduled publish via `POST /api/cron/publish` (idempotent).
- **Content calendar** (`/dashboard/content/calendar`).

New deps: `unpdf` (PDF text), `node-html-parser` (HTML→text), `robots-parser`.
Retrieval is keyword+recency (semantic/vector search is a documented backlog
item — the natural home for a small Python ML service). No new required key
beyond `ANTHROPIC_API_KEY`; `LINKEDIN_ORG_URN` is optional/pending.

## Shipped in Sprint 2

- **LinkedIn official OAuth (OIDC)** — connect/disconnect flow, tokens encrypted
  at rest (AES-256-GCM), CSRF-protected, audited. Company-page reads/publishing
  are stubbed pending LinkedIn Marketing API approval.
- **AI Trend Intelligence** — modular sources (`server/trends/sources/`: Reddit,
  Hacker News, Google News RSS, X-stub), a pure scoring engine
  (`server/trends/scoring.ts`), a reusable Claude wrapper (`server/ai/claude.ts`),
  idempotent daily digest generation, and the `/dashboard/trends` UI with a
  keyword/source config page.

## Explicitly deferred to later sprints

- **LinkedIn publishing + company-page data** — requires LinkedIn Marketing
  Developer Platform / Community Management approval; scaffolded + flagged.
- **Content Studio (Sprint 3)** — the "Generate content from this" button on
  each trend card links to the reserved `/dashboard/content/new?trendId=…`.
- **Real email delivery** — `lib/email.ts` logs to console; swap in Resend with
  no call-site changes.
- **Outreach, Engagement, Analytics** — nav items render "Coming in Sprint N"
  placeholders driven by `lib/nav.ts`.
- **Team invitations / billing** — the RBAC pattern (`lib/rbac.ts`) exists;
  enforcement surfaces land with those features.

---

See [`DESIGN.md`](DESIGN.md) for design tokens and component conventions.
