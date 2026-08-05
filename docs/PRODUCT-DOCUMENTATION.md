# Botella Aura — Complete Product & Technical Documentation

> **Botella Aura is an AI Marketing Co-Pilot for B2B teams.** It researches what
> your market is talking about, learns how your company sounds, generates
> on-brand content, finds and qualifies prospects, drafts personalized outreach,
> tracks competitors, measures real results, and learns from them — with a
> **human approval step in front of everything that leaves the building.**
>
> Nothing auto-posts. Nothing auto-connects. Nothing auto-comments. Ever.

---

## Table of contents

1. [What Botella Aura is](#1-what-botella-aura-is)
2. [The problem it solves](#2-the-problem-it-solves)
3. [Core principles (the non-negotiables)](#3-core-principles-the-non-negotiables)
4. [How it works — the end-to-end loop](#4-how-it-works--the-end-to-end-loop)
5. [System architecture](#5-system-architecture)
6. [The AI layer](#6-the-ai-layer)
7. [Feature reference (every module in detail)](#7-feature-reference-every-module-in-detail)
   - [7.1 Accounts, workspaces & onboarding](#71-accounts-workspaces--onboarding)
   - [7.2 Knowledge Base & Brand Voice](#72-knowledge-base--brand-voice)
   - [7.3 Trend Intelligence](#73-trend-intelligence)
   - [7.4 Content Studio](#74-content-studio)
   - [7.5 Publishing & the content calendar](#75-publishing--the-content-calendar)
   - [7.6 The Chrome Extension — the action layer](#76-the-chrome-extension--the-action-layer)
   - [7.7 Lead Discovery Engine](#77-lead-discovery-engine)
   - [7.8 Outreach Intelligence](#78-outreach-intelligence)
   - [7.9 Engagement Copilot](#79-engagement-copilot)
   - [7.10 Competitor Intelligence](#710-competitor-intelligence)
   - [7.11 Marketing Memory (the learning loop)](#711-marketing-memory-the-learning-loop)
   - [7.12 Campaign Orchestrator](#712-campaign-orchestrator)
   - [7.13 Analytics](#713-analytics)
   - [7.14 Billing & plans](#714-billing--plans)
   - [7.15 Audit trail](#715-audit-trail)
8. [Data model](#8-data-model)
9. [API reference](#9-api-reference)
10. [Scheduled jobs (cron)](#10-scheduled-jobs-cron)
11. [Security model](#11-security-model)
12. [Configuration & environment variables](#12-configuration--environment-variables)
13. [Running it locally](#13-running-it-locally)
14. [Deployment](#14-deployment)
15. [Testing & quality gates](#15-testing--quality-gates)
16. [Design system](#16-design-system)
17. [What it deliberately does NOT do](#17-what-it-deliberately-does-not-do)
18. [Glossary](#18-glossary)

---

## 1. What Botella Aura is

Botella Aura is a **multi-tenant SaaS web application** (Next.js 14 + PostgreSQL)
plus a **companion Chrome Extension**. Together they form a marketing co-pilot
for LinkedIn-centric B2B go-to-market work.

The split matters and is the product's central design decision:

| Layer | Runs where | Responsibility |
|---|---|---|
| **The web app** | Your server | Research, thinking, generating, storing, measuring. Talks to public APIs, RSS feeds, websites, Anthropic/Google. |
| **The Chrome Extension** | Your own browser, in your own logged-in session | The *doing*. Inserts approved text into LinkedIn's own composer. **You** click Post. |

The backend **never logs into LinkedIn, never stores LinkedIn cookies, never
scrapes linkedin.com, and never automates a click.** That is what makes the
product safe to use with a real LinkedIn account you care about.

**Product name in code:** `botella-aura` · **Tagline:** "Your AI Marketing
Co-Pilot — safe by design."

---

## 2. The problem it solves

A B2B marketing team (or a one-person founder-marketer) has to do, every week:

- Know what their market is talking about *today*.
- Publish content that sounds like them, not like ChatGPT.
- Find prospects worth talking to.
- Write outreach that isn't generic.
- Comment thoughtfully on other people's posts.
- Watch what competitors are shipping.
- Measure what worked and do more of it.

Each of these is a research task followed by a writing task followed by a
judgment call. Aura automates the **research** and the **first draft** of every
one of them, keeps everything grounded in the company's own material, and leaves
the **judgment call and the send button** to a human.

The result: the work of a marketing team, at the speed of AI, without the two
things that kill AI marketing tools — off-brand output and banned accounts.

---

## 3. Core principles (the non-negotiables)

These are enforced in code, not just documented. They recur throughout the
codebase as `NON-NEGOTIABLE` comments.

### 1. Human-in-the-loop before anything goes out

Every artifact — content draft, outreach message, engagement comment — moves
through an explicit approval state machine. `PUBLISHED` is reachable **only**
from `APPROVED`, enforced in the service layer
([`server/content/content.service.ts:184`](../server/content/content.service.ts#L184)),
so no code path — including the campaign orchestrator and the scheduled
publisher — can publish an unapproved item.

```
DRAFT → PENDING_APPROVAL → APPROVED → PUBLISHED   (PUBLISHED is terminal)
   ↘         ↘        ↘
        REJECTED → DRAFT
```

### 2. Never fabricate a number or an insight

Performance metrics only exist when a real source provided them. Marketing
Memory refuses to produce insights below **10 measured posts** and says so
plainly ([`server/memory/metrics.ts`](../server/memory/metrics.ts)). Analytics
reports `hasData: false` rather than drawing a zero chart. A publish is only
called "published" when a real API call succeeded — otherwise it is honestly
labelled "copy for manual posting."

### 3. Public sources only, respectfully accessed

Website ingestion and competitor tracking respect `robots.txt`, throttle per
origin, and identify themselves with a real user agent (`BotellaAuraBot/0.1`).
No unofficial endpoints, no scraping of authenticated surfaces, ever.

### 4. Multi-tenant isolation

Every query is company-scoped. There is a dedicated test suite
([`tests/tenant-isolation.test.ts`](../tests/tenant-isolation.test.ts)) proving
company B cannot read company A's data.

### 5. Everything is audited

Every meaningful action writes a typed `AuditLog` row — signup, login, config
change, AI suggestion, approval, rejection, publish, send. Audit writes never
break the primary action (a logging failure is recorded and swallowed).

### 6. Degrade honestly, never silently

Missing API key → the feature says what's missing and falls back to a
non-AI/heuristic path, or reports the source as `skipped` in the run summary. It
never pretends a source ran.

### 7. Idempotent scheduled work

Daily digests are unique per `(companyId, date)`; weekly competitor reports per
`(companyId, weekStart)`; analytics reports per `(companyId, periodStart)`. A
double-fired cron overwrites — it never duplicates.

---

## 4. How it works — the end-to-end loop

```
                    ┌──────────────────────────────────────────┐
                    │  1. TEACH IT YOUR VOICE                  │
                    │  Website + blog + uploads → chunks       │
                    │  → AI Brand Voice Profile (you edit it)  │
                    └────────────────────┬─────────────────────┘
                                         │
        ┌────────────────────────────────┼─────────────────────────────┐
        ▼                                ▼                             ▼
┌───────────────┐            ┌──────────────────────┐      ┌────────────────────┐
│ 2. RESEARCH   │            │ 3. FIND PEOPLE       │      │ 4. WATCH RIVALS    │
│ Trend digests │            │ Discovery + signals  │      │ Competitor diffs   │
│ (Reddit, HN,  │            │ (GitHub, news, jobs, │      │ + weekly AI report │
│  Google News) │            │  Crunchbase, CSE)    │      │                    │
└───────┬───────┘            └──────────┬───────────┘      └────────────────────┘
        │                               │
        ▼                               ▼
┌────────────────────────┐   ┌────────────────────────┐
│ 5. GENERATE            │   │ 6. DRAFT OUTREACH      │
│ posts / carousels /    │   │ connection notes +     │
│ threads / blogs        │   │ follow-ups per lead    │
│ grounded in your KB    │   │ grounded in the signal │
└───────────┬────────────┘   └───────────┬────────────┘
            │                            │
            └──────────────┬─────────────┘
                           ▼
              ┌─────────────────────────┐
              │ 7. YOU APPROVE          │   ← the gate. Nothing passes without it.
              │ /dashboard/content      │
              │ /dashboard/outreach     │
              └────────────┬────────────┘
                           ▼
              ┌─────────────────────────┐
              │ 8. YOU SEND             │
              │ Chrome Extension queue  │   ← one human click per action
              │ → LinkedIn's own UI     │
              └────────────┬────────────┘
                           ▼
              ┌─────────────────────────┐
              │ 9. MEASURE              │
              │ extension syncs the     │
              │ counts on YOUR post     │
              └────────────┬────────────┘
                           ▼
              ┌─────────────────────────┐
              │ 10. LEARN               │
              │ Marketing Memory →      │──┐
              │ injected into every     │  │  feeds back into step 5 & 6
              │ future generation       │  │  → drafts get better weekly
              └─────────────────────────┘◄─┘
```

Step 10 closing back into step 5 is the compounding mechanic: **the longer you
use Aura, the better its first drafts are**, because real performance data is
turned into instructions the generator reads.

The **Campaign Orchestrator** sits above all of this: give it one goal, and it
plans 30 days of the above and triggers it day by day — still landing everything
in the same approval queues.

---

## 5. System architecture

### Stack

| Concern | Choice | Why |
|---|---|---|
| App framework | **Next.js 14 (App Router)** | One deployable; Zod schemas and types shared between client and server. |
| Language | **TypeScript (strict)** | `pnpm typecheck` is a gate. |
| Database | **PostgreSQL + Prisma 5** | Typed access; schema designed up front for the whole roadmap. |
| Auth | **NextAuth v4** + Prisma adapter | Credentials + Google OAuth; adding providers is one entry in `lib/auth.ts`. |
| Validation | **Zod** | One schema per input, reused by the form, the route, and the tests. |
| AI | **Anthropic Claude** (primary), **Google Gemini** (fallback) | See §6. |
| UI | **Tailwind + shadcn/ui pattern (Radix + cva)** | See §16. |
| Payments | **Stripe** (hosted Checkout + Portal) | No card data ever touches the app. |
| Testing | **Vitest** + Testing Library | 18 suites; see §15. |
| Package manager | **pnpm ≥ 9**, Node ≥ 20 | |

### Layered request flow (defense in depth)

```
Browser
   │
   ▼
① middleware.ts (Edge)        — redirects unauthenticated users away from
   │                            /dashboard/* and /onboarding before any code runs
   ▼
② app/api/**/route.ts         — Zod-validates every input; resolves the session;
   │                            enforces company scope + RBAC + entitlements
   ▼
③ server/**/*.service.ts      — ALL business logic and ALL writes live here.
   │                            Action + AuditLog in one Prisma transaction.
   ▼
④ Prisma → PostgreSQL
```

Route handlers stay thin: parse → authorize → delegate → format. Business logic
never lives in a route.

### Folder map

```
app/
  (auth)/           login · signup · forgot-password · reset-password
  onboarding/       3-step post-signup wizard
  dashboard/        the product — one folder per module
  api/              route handlers (see §9)
  page.tsx          public marketing landing page
components/
  ui/               design-system primitives (Button, Card, Dialog, Badge, …)
  dashboard/<mod>/  feature UI, one folder per module
  onboarding/ auth/ brand/
lib/
  db.ts             Prisma singleton
  auth.ts           NextAuth config              auth-helpers.ts  session/company guards
  rbac.ts           role → permission matrix     crypto.ts        AES-256-GCM + token hashing
  extension-auth.ts extension bearer auth + CORS rate-limit.ts    sliding-window limiter
  http.ts           the ONLY outbound fetch      monitoring.ts    captureException (Sentry-ready)
  validations/      Zod schemas (10 files — the single source of truth)
server/
  ai/               the one Claude/Gemini client
  knowledge/        ingest · extract · chunk · retrieve · robots
  content/          brand-voice · generator · content (state machine) · publish · render
  trends/           sources/ + pure scoring engine
  competitors/      sources/ + diff · tracking · report
  leads/            discovery/ (sources · scoring · dedup) · profile · detail
  outreach/         sources/ + detect · matching · drafting · lead · outreach · config
  engagement/       target · comment
  extension/        token · queue · action
  memory/           metrics · performance · extraction · memory
  campaigns/        planner · executor · checkpoint · campaign
  analytics/        analytics · report
  billing/          checkout · subscription · entitlements
  services/         user · company · audit · auth-token · linkedin · trend-config
extension/          MV3 Chrome extension (no bundler — plain JS/CSS)
prisma/             schema.prisma · migrations/ · seed.ts
tests/              Vitest suites
docs/               per-sprint technical docs + this file
```

### Outbound HTTP discipline

There is **no inline `fetch()`** to third parties anywhere in the server code.
All outbound requests go through [`lib/http.ts`](../lib/http.ts), which
centralizes timeouts, the user agent, retry policy, and error shape. This is what
makes "respect robots.txt and throttle per origin" enforceable rather than
aspirational.

---

## 6. The AI layer

One module — [`server/ai/claude.ts`](../server/ai/claude.ts) — is the *only*
place the app talks to a model. Every feature reuses it.

**Provider strategy:**

- **Anthropic Claude** when `ANTHROPIC_API_KEY` is set. Default model
  `claude-opus-4-8`, overridable via `ANTHROPIC_MODEL`. Uses adaptive thinking
  with a configurable effort level (`low`/`medium`/`high`/`xhigh`/`max`,
  defaulting to `high`).
- **Google Gemini** when only `GEMINI_API_KEY` is set (default
  `gemini-flash-latest`), called over the REST API with no extra SDK.
- **Neither configured** → `ClaudeNotConfiguredError`, and every call site
  catches it and falls back to a documented non-AI path.

**Three call shapes:**

| Function | Returns | Used for |
|---|---|---|
| `complete()` | plain text | summaries, prose |
| `completeJson<T>()` | parsed JSON | loosely-shaped payloads |
| `completeStructured({ schema })` | **Zod-validated** object | all content generation, campaign plans, insight extraction |

**Reliability behaviour built in:**

- One automatic retry on transient API failure.
- Generations over 8,000 max-tokens **stream** automatically (avoids HTTP
  timeouts on long outputs).
- `completeStructured` retries **once** on schema-validation failure, feeding the
  exact validation error and required shape back into the prompt. If the retry
  still fails it throws — this is the guarantee behind *"malformed content is
  never saved."*
- `parseJson()` tolerantly strips ```` ```json ```` fences and surrounding prose.

Every AI-produced record stores its generation context in an `aiMetadata` JSON
column: model, prompt version, which knowledge chunks grounded it, whether the
brand voice was applied, and the source of the brief. That is what makes AI
output auditable after the fact.

---

## 7. Feature reference (every module in detail)

### 7.1 Accounts, workspaces & onboarding

**Sign-up paths:** email + password (bcrypt via `bcryptjs` — pure JS, so no
native build step on Windows/CI) or **Continue with Google** (only rendered when
`GOOGLE_CLIENT_ID`/`_SECRET` exist, so the app runs fine without it).

**Password reset:** single-use, expiring tokens. Only a **SHA-256 hash** of the
token is stored; the raw token exists only in the emailed link
(`server/services/auth-token.service.ts`). Auth endpoints are rate-limited.

**Multi-tenancy:** a `Company` is the tenant boundary. A `CompanyMember` join
table gives a user a **per-company role**, so one person can belong to several
workspaces with different permissions — this drives the topbar company switcher.

**RBAC** ([`lib/rbac.ts`](../lib/rbac.ts)):

| Permission | OWNER | ADMIN | MEMBER |
|---|:--:|:--:|:--:|
| `company:update` | ✅ | ✅ | — |
| `company:delete` | ✅ | — | — |
| `company:manageBilling` | ✅ | — | — |
| `members:invite` / `members:remove` | ✅ | ✅ | — |
| `linkedin:connect` | ✅ | ✅ | — |
| `content:approve` | ✅ | ✅ | — |
| `content:publish` | ✅ | ✅ | — |

Members can draft; only owners/admins can approve, publish, or change settings.

**Onboarding wizard** (`/onboarding`) — three steps:
1. **Company** — name, website, industry.
2. **Brand voice** — free-text notes on how the company should sound.
3. **All set** — a summary of what Aura will now do.

Onboarding data seeds the rest of the product: industry + brand-voice notes are
used to generate smart trend-keyword defaults, and the notes feed the Brand Voice
Profile. `Company.preferences` is an extensible JSON bag so later signals can be
added without a migration.

---

### 7.2 Knowledge Base & Brand Voice

**Where:** `/dashboard/settings/knowledge-base` · code in `server/knowledge/`
and `server/content/brand-voice.service.ts`.

This is the foundation of output quality. Everything Aura writes is grounded in
material the company actually produced.

**Ingestion sources:**

| Type | How |
|---|---|
| `WEBSITE` | Crawl the company site — **robots.txt-gated**, throttled per origin, identified as `BotellaAuraBot/0.1`. HTML → text via `node-html-parser`. |
| `BLOG` | RSS/Atom feeds parsed with `fast-xml-parser`. |
| `UPLOAD` | `.txt`, `.md`, and `.pdf` (text extracted with `unpdf`). |
| `PAST_POST` | Previous posts, the strongest voice signal. |

**Chunking** ([`server/knowledge/chunk.ts`](../server/knowledge/chunk.ts)):
splits on paragraph boundaries and accumulates to ~3,200 characters (~800
tokens) so chunks stay semantically coherent rather than cut mid-sentence.
Fragments under 80 characters are dropped as noise. Token counts are estimated
without pulling in a tokenizer dependency.

**Retrieval** ([`server/knowledge/retrieve.ts`](../server/knowledge/retrieve.ts)):
a deterministic **keyword + recency** heuristic — stop-worded term overlap,
weighted by source type (`PAST_POST` 1.25× > `BLOG` 1.15× > `UPLOAD` 1.1× >
`WEBSITE` 1.0×) and boosted by recency. Dependency-free, cheap, and unit-tested.
Semantic/vector retrieval (pgvector or a small Python embedding service) is a
documented backlog upgrade behind the same `retrieve()` interface, so no call
site would change.

**Brand Voice Profile** — the single biggest quality lever. Claude analyzes the
retrieved chunks plus the onboarding notes and produces a structured, schema-
validated profile (tone, vocabulary, sentence rhythm, do/don't lists). It is
stored on `Company.brandVoiceProfile`, **fully human-editable**, and injected
into **every** generation prompt in the product. Without an AI key, a heuristic
profile is built from the onboarding notes so the product still works.

**Guarantee:** a generation call that skips knowledge retrieval or brand-voice
injection is treated as a bug.

---

### 7.3 Trend Intelligence

**Where:** `/dashboard/trends` · config at `/dashboard/settings/trends` · code in
`server/trends/`.

A **daily digest of what your market is talking about**, with a suggested angle
for each item.

**Sources** (modular — one file per source in `server/trends/sources/`):

| Source | Credentials | Notes |
|---|---|---|
| **Hacker News** | none | Algolia public API |
| **Google News RSS** | none | keyword-driven queries + your own extra feeds |
| **Reddit** | `REDDIT_CLIENT_ID/_SECRET/_USER_AGENT` | app-only read token, monitors your chosen subreddits |
| **X / Twitter** | `TWITTER_BEARER_TOKEN` | off by default |

**Scoring** ([`server/trends/scoring.ts`](../server/trends/scoring.ts)) is a
**pure function** (no I/O, `now` injected — trivially testable). Each item gets
0–100 from three weighted signals:

- **Recency** (35%) — exponential decay, 24-hour half-life.
- **Engagement** (30%) — log-scaled `points + 2 × comments`, saturating at 500.
- **Relevance** (35%) — keyword-match strength with diminishing returns after
  ~3 matches, plus a competitor-mention boost.

**AI enrichment:** Claude adds a *"why this matters to you"* summary and a
*suggested content angle* per item. Without an AI key, digests fall back to basic
non-AI summaries rather than disappearing.

**Configuration** per company (`CompanyTrendConfig`): keywords, subreddits, extra
RSS feeds, competitor names to watch for, and per-source on/off toggles. Smart
defaults are generated once from onboarding data by a single Claude call, then
never overwritten (`defaultsSeeded` flag) so your edits stick.

**Idempotency:** one digest per company per calendar day, upserted on
`(companyId, date)`. Run it via `POST /api/cron/trends` daily, or hit **Refresh**
in the dashboard.

Every trend card has **"Generate content from this"**, which hands the item
straight to Content Studio as a brief.

---

### 7.4 Content Studio

**Where:** `/dashboard/content` (queue) · `/dashboard/content/new` (generate) ·
`/dashboard/content/[id]` (editor) · `/dashboard/content/calendar` · code in
`server/content/`.

The flagship module.

**Content types** — each with its own strict Zod output schema:

| Type | Shape the model must return |
|---|---|
| `LINKEDIN_POST` | `{ hook, paragraphs[3..5], hashtags[0..8] }` — hook-first, short skimmable paragraphs, light CTA |
| `CAROUSEL` | `{ title, slides[5..8]{ headline, body }, hashtags[0..8] }` — slide 1 is the cover, last is the CTA |
| `TWEET_THREAD` | `{ tweets[2..12] }` — each ≤ 280 chars, one idea each |
| `BLOG` | `{ headline, subtitle, sections[2..10]{ heading, body }, tags[0..10] }` |

**Generation pipeline** (every single call, in order):

```
resolve the brief (trend item · free-text topic · campaign task)
   → retrieve grounding chunks from the knowledge base
   → inject the Brand Voice Profile
   → inject active Marketing Memory insights
   → prompt Claude with the exact JSON schema for this type
   → validate against the Zod schema (retry once with the error on failure)
   → persist as a DRAFT ContentDraft + record aiMetadata + AuditLog
```

**The approval queue** (`/dashboard/content`) — a kanban board by status with:

- A **detail editor** with a faithful per-type preview (a carousel previews as
  slides; a thread previews as tweets).
- **Refine** — targeted revision from a natural-language instruction
  (`POST /api/content/drafts/[id]/refine`).
- **Regenerate** — a fresh generation from the same brief.
- **Bulk actions** (`POST /api/content/drafts/bulk`) — approve/reject in batches.
- **Reject with a reason**, stored on the draft.
- **Schedule** for a future publish time.

**The state machine** ([`server/content/content.service.ts`](../server/content/content.service.ts)):

```ts
DRAFT:            → PENDING_APPROVAL, REJECTED
PENDING_APPROVAL: → APPROVED, REJECTED, DRAFT
APPROVED:         → PUBLISHED, DRAFT, REJECTED
REJECTED:         → DRAFT
PUBLISHED:        → (terminal)
```

Invalid transitions throw a `409`. `assertPublishable()` is called even on the
*internal* `markPublished()` path, so no code path anywhere — cron, campaign
executor, or API — can publish something that wasn't approved by a human.

---

### 7.5 Publishing & the content calendar

**Code:** [`server/content/publish.service.ts`](../server/content/publish.service.ts).

Publishing has three honest outcomes:

| Result | Meaning |
|---|---|
| `published` | A **real** official-API post succeeded. The returned URL/URN is stored on the draft. |
| `manual` | The formatted text is handed back to copy (or picked up by the extension queue) — with a plain-English reason. |
| `reconnect` | The LinkedIn connection expired or errored; the user is prompted to reconnect. |

**The LinkedIn reality, stated plainly:** auto-publishing to a Company Page needs
LinkedIn's **Community Management API** — product approval, the
`w_organization_social` scope, and an organization URN (`LINKEDIN_ORG_URN`) the
connected user administers. Aura currently connects through the self-serve
**OpenID Connect** product (`openid profile email`), which **cannot post**. The
real `/rest/posts` call is fully wired (versioned via `LINKEDIN_API_VERSION`) and
will run the moment the scope and org URN are present. Until then every type
routes to the manual fallback. **A fake "published" state is never written.**

Carousels, threads, and blogs can't be auto-published through LinkedIn's API at
all — only single posts can — so those always return the manual path with that
explanation.

**Scheduled publishing:** `POST /api/cron/publish` (suggested every 15 minutes)
picks up drafts whose `scheduledFor` has passed. Idempotent.

**Calendar** (`/dashboard/content/calendar`): a month view of scheduled and
published content.

---

### 7.6 The Chrome Extension — the action layer

**Code:** [`extension/`](../extension/) · server side in `server/extension/` and
`lib/extension-auth.ts` · settings at `/dashboard/settings/extension`.

Manifest V3, plain JS/CSS, **no bundler** — load the folder directly.

```
manifest.json        MV3 manifest — permissions: storage, activeTab only
background.js        service worker: holds the token, is the SINGLE API
                     choke-point, enforces the client-side rate cap
popup.html/.js/.css  pair · status · usage · disconnect
content/pairing.js   runs on the Aura origin — receives the token via postMessage
content/linkedin.js  runs on linkedin.com — the floating ✦ Aura action panel
content/linkedin.css panel styles (namespaced .aura-*)
```

**What it does — exactly three things:**

1. Reads a queue of **approved** items the backend prepared.
2. **Inserts** the approved text into LinkedIn's own composer / comment box when
   you click.
3. Syncs status back after **you** post it.

It never auto-sends, never loops, never runs on a timer.

**The queue** (`GET /api/extension/queue`) aggregates three item types, each with
the exact text to inject and an injection target:

| Item type | Source | Target |
|---|---|---|
| `content_draft` | APPROVED Content Studio drafts | `linkedin_compose` |
| `outreach_message` | APPROVED outreach notes/follow-ups | `linkedin_message` |
| `engagement_comment` | Drafted comments | `linkedin_comment` |

**Rate caps** ([`lib/extension-constants.ts`](../lib/extension-constants.ts)):
**8 actions/hour, 25/day**, enforced **client-side in the extension** (the hard
requirement — it stops even a well-intentioned power user from looking like a
bot) and **again server-side** as defense in depth.

**Auth:** a separate, revocable, **workspace-scoped bearer token** (`aura_ext_…`)
— *not* your web session. Only `sha256(token)` is stored server-side; the raw
token lives only in `chrome.storage.local`. It authorizes **only**
`/api/extension/*` — never your full account — and is revocable instantly from
Settings → Browser extension → Disconnect. `EXTENSION_ALLOWED_ORIGIN` pins the
published extension origin in production.

**Pairing:** Settings → Browser extension → *Generate pairing token* → either
**Send to extension** (a `window.postMessage` the `pairing.js` content script
picks up, which also pins the API base to the origin you paired from) or paste
the token into the popup.

**The metrics sync** (`POST /api/extension/metrics`): when you visit **your own**
post, the extension reads the like/comment counts **already rendered on your
screen** and syncs them. There is no server-side LinkedIn fetch. This is where
real performance data enters the system.

---

### 7.7 Lead Discovery Engine

**Where:** `/dashboard/leads` · `/dashboard/leads/discover` · code in
`server/leads/discovery/`.

**Proactive prospecting.** You define a reusable `DiscoveryProfile` — industry,
stage, role titles, geography, keywords — and Aura searches legitimate public
sources to build an AI-scored lead list.

**Sources:**

| Source | Credentials | Runs by default? |
|---|---|---|
| **GitHub org search** | optional `GITHUB_TOKEN` (higher rate limit) | ✅ keyless |
| **Company team/about pages** | none | ✅ keyless, robots-gated |
| **Crunchbase** | `CRUNCHBASE_API_KEY` | only with key |
| **Google Custom Search** | `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` | only with key |

**How a run works:**

1. Parse and validate the profile's `criteria`.
2. Create a `DiscoveryRun` row (`RUNNING`).
3. Fan out across the enabled sources (max ~8 companies deep for team-page
   crawling, max 25 new leads per run).
4. **Dedupe** candidates against each other *and* against existing leads
   ([`server/leads/discovery/dedup.ts`](../server/leads/discovery/dedup.ts)) — a
   discovered lead never duplicates a Sprint-4 signal lead; it merges instead.
5. **AI-score** each lead 0–100 for fit against the criteria, with a short,
   human-readable `fitRationale` ("why this lead").
6. Finish the run with a `summary` recording **per-source counts and skipped
   sources**, so a run that found nothing is honestly empty rather than silently
   broken.

Leads carry a `source` of `SIGNAL` (reactive detection), `DISCOVERY_ENGINE`
(proactive), or `MANUAL`. Discovered leads flow into the **existing** outreach
pipeline via **Draft outreach** — there is no parallel pipeline.

Profiles can `autoRun` weekly via `POST /api/cron/discovery`.

---

### 7.8 Outreach Intelligence

**Where:** `/dashboard/outreach` · config at `/dashboard/settings/outreach` ·
code in `server/outreach/`.

**Reactive lead detection.** Where Discovery goes looking, Outreach watches for
buying signals and brings leads to you.

**Signal sources** (`server/outreach/sources/`): **GitHub** activity, **news**,
**hiring/jobs RSS**, and **Crunchbase** funding (behind an optional key).
Detected signal types: `FUNDING`, `HIRING`, `GITHUB_ACTIVITY`, `NEWS`,
`LEADERSHIP_CHANGE`.

**Granularity matters:** signals are detected at **company** granularity. Aura
creates/updates a `Lead` for the target organization and attaches a `LeadSignal`.
The **person's** name, title, and LinkedIn profile URL are added or confirmed **by
you** — they are never scraped from LinkedIn.

**Targeting config** (`OutreachConfig`): industries you sell into, role titles
worth reaching, company stages/sizes, and per-source toggles. Disabled or
unavailable sources are reported as `skipped` with a reason.

**Drafting** ([`server/outreach/drafting.service.ts`](../server/outreach/drafting.service.ts)):
Claude writes a **connection note** or **follow-up**, grounded in (a) the specific
public signal that surfaced this lead, (b) your Brand Voice Profile, and (c)
active Marketing Memory insights about which outreach approaches have actually
worked for you.

**Lifecycle** — mirrors content exactly:

```
DRAFT → PENDING_APPROVAL → APPROVED → SENT
   ↘  REJECTED
```

`SENT` requires **both** an explicit human Approve in the web app **and** a human
click in the extension. Follow-ups are only offered after a connection is
accepted — which is tracked via the extension and a manual toggle, not an API.

**Outcome tracking:** `connectionAccepted` and `replyReceived` are manual
booleans (`POST /api/outreach/messages/[id]/outcome`), because no API exposes
them. These feed the learning loop and the analytics funnel.

Run detection on a schedule via `POST /api/cron/outreach` (daily).

---

### 7.9 Engagement Copilot

**Where:** `/dashboard/engagement` (read-only history) · monitored profiles at
`/dashboard/settings/engagement` · code in `server/engagement/`.

Commenting thoughtfully on other people's posts is high-leverage and
time-expensive. Aura drafts the comment; you post it.

**How it works — and the constraint that makes it safe:** while you are viewing a
post on LinkedIn, you open the extension panel and click **Draft a comment for
this post**. The extension reads **only the post text already rendered on your
own screen**, sends it to `POST /api/extension/engagement/draft`, and Claude
writes an on-brand comment. You insert it into LinkedIn's own comment box and
post it yourself.

**There is no server-side LinkedIn fetch anywhere in this flow.** The web app is
purely the system of record — a read-only history at `/dashboard/engagement` with
statuses `DRAFT` / `POSTED` / `DISCARDED`.

`EngagementTarget` rows let you list public profiles/pages you care about, but
monitoring happens entirely in the extension against the DOM already shown to
you. The backend never fetches those feeds.

---

### 7.10 Competitor Intelligence

**Where:** `/dashboard/competitors` · reports at
`/dashboard/competitors/reports` · code in `server/competitors/`.

Track competitors from **public signal only**.

**Per competitor you can track:** homepage URL, pricing page URL, GitHub org, a
LinkedIn company page URL (display only), free-text notes, and a
`trackingEnabled` toggle.

**What a tracking run does** ([`tracking.service.ts`](../server/competitors/tracking.service.ts)):

1. Fetch the homepage and pricing page — **robots-respecting**, throttled.
2. Normalize to text, take a **SHA-256 hash**, and compare with the previous
   snapshot's hash for fast change detection.
3. When content changed, compute a text diff and have Claude write a **human-
   readable change summary** ("they added a Teams tier at $49/seat and dropped
   the free plan").
4. Gather public **news/RSS** mentions and **GitHub** public-API activity.
5. Persist a `CompetitorSnapshot` with a structured `changesSummary`.

**Weekly AI report** (`CompetitorReport`, idempotent per `(companyId, weekStart)`
where `weekStart` is Monday 00:00 UTC): per competitor — new launches, pricing
changes, notable activity, and a **strategic takeaway** — plus a cross-competitor
synthesis.

**The honest gap:** the LinkedIn company-page feed is a **flagged stub**
([`server/competitors/sources/linkedin.ts`](../server/competitors/sources/linkedin.ts)).
There is no official API scope for it, and Aura does not scrape. The stub is
labelled in the UI rather than silently omitted.

Schedule with `POST /api/cron/competitors` (weekly).

---

### 7.11 Marketing Memory (the learning loop)

**Where:** `/dashboard/memory` · code in `server/memory/`.

This is what makes Aura compound in value. **The product remembers what works.**

**Where real data comes from — three honest sources only** (`PerformanceSource`):

| Source | How |
|---|---|
| `EXTENSION_DOM` | The extension reads the counts already visible on **your own** post page and syncs them. |
| `MANUAL` | You toggle outreach outcomes (connection accepted / reply received). |
| `LINKEDIN_API` | Available only if/when API analytics scope exists. Currently unavailable — and honestly reported as such. |

A `PerformanceSnapshot` only exists when a real source provided numbers. There is
no estimation, no interpolation, no "typical engagement" placeholder.

**Engagement scoring** ([`server/memory/metrics.ts`](../server/memory/metrics.ts))
is a weighted scalar reflecting effort-to-produce:

```
engagement = likes + 3×comments + 4×reposts + 2×clicks
```

**Insight extraction** (weekly, `POST /api/cron/memory`):

- **Below 10 measured posts** → the job writes a single honest record:
  *"Not enough data yet — publish and sync metrics for at least 10 posts, then
  check back. (N so far.)"* **It does not invent insights.**
- **At or above 10** → Claude extracts structured, schema-validated
  `MarketingMemory` insights, typed as `CONTENT_FORMAT`, `CONTENT_LENGTH`,
  `TIMING`, `TOPIC`, `HASHTAG`, `OUTREACH_APPROACH`, or `OTHER`.

**Every insight carries its evidence:** a `supportingDataSummary` JSON with the
basis, the metric, and the specific item IDs behind it. **Confidence is derived
purely from sample size** — `LOW` < 15, `MEDIUM` 15–29, `HIGH` ≥ 30 — never from
how confident the model sounds.

**The feedback loop:** active insights are injected into the **content generator**
and the **outreach drafter** on every call
(`getActiveMemories()` → `memoriesToPrompt()`). Regeneration deactivates the
previous generation rather than deleting it, so history is preserved.

The dashboard shows insight cards (with the data behind each), an engagement
trend chart, and best/worst performing posts.

---

### 7.12 Campaign Orchestrator

**Where:** `/dashboard/campaigns` · `/dashboard/campaigns/new` ·
`/dashboard/campaigns/[id]` · code in `server/campaigns/`.

**One goal in → a full, reviewable 30-day plan out.**

You provide: a goal, target audience, themes, duration (default 30 days), and
which modules to include (`content`, `outreach`, `engagement`, `discovery`).
Claude produces a day-by-day plan, **validated against
`campaignPlanSchema`** ([`lib/validations/campaign.ts`](../lib/validations/campaign.ts)),
which the planner materializes into `CampaignTask` rows.

**Task types:**

| Task | What the daily cron triggers |
|---|---|
| `GENERATE_CONTENT` | The Sprint-3 content generator with the planned type + topic + angle |
| `RUN_OUTREACH_BATCH` | The outreach drafter for a batch of 3 leads |
| `RUN_DISCOVERY` | A discovery run against an active profile |
| `REVIEW_CHECKPOINT` | An AI-written weekly progress summary |

**The critical architectural property:** the executor
([`executor.service.ts`](../server/campaigns/executor.service.ts)) is a
**conductor, not a performer**. It contains **no generation logic of its own** —
it triggers the existing Sprint 3–5 pipelines, and everything they produce lands
in the **normal approval queue as a DRAFT**. The orchestrator **never publishes
or sends anything.** This is verified by test.

`POST /api/cron/campaigns` runs daily, processing up to 100 due tasks for
`ACTIVE` campaigns. Failures are captured per task (`FAILED` + error message +
`CAMPAIGN_TASK_FAILED` audit entry) without killing the run. Campaigns can be
paused and resumed. Each task drills through to the item it produced.

Campaign lifecycle: `DRAFT → ACTIVE → PAUSED → COMPLETED → ARCHIVED`.

---

### 7.13 Analytics

**Where:** `/dashboard/analytics` · code in `server/analytics/`.

The **client-presentable results view** — distinct from Marketing Memory, which
is the *learnings* view.

**Top-line metrics** over a selectable range (default 30 days):

- Posts published
- Total engagement
- Outreach sent
- Connections made
- Replies received
- Leads discovered
- Campaigns run

**Plus:** an engagement trend over time, content volume over time, an **outreach
funnel** (sent → connected → replied), and a **channel breakdown** by content
type with average engagement each.

**Honest empty states:** the result carries a `hasData` flag. A range with no
captured data reports `hasData: false` so the UI shows *"not enough data yet"*
rather than a misleading chart of zeros.

**The written weekly report** (`AnalyticsReport`, idempotent per
`(companyId, periodStart)`): Claude writes a plain-English narrative **from the
real numbers**, ready to copy and send to a client or a founder. Generate on
demand (`POST /api/analytics/report`) or weekly (`POST /api/cron/analytics`).

---

### 7.14 Billing & plans

**Where:** `/dashboard/settings/billing` · code in `server/billing/`.

**Stripe hosted Checkout + Customer Portal** — no card data ever touches the
app. Webhooks at `/api/webhooks/stripe` are **signature-verified**, handling
checkout completion, subscription updates, cancellations, and payment failures.
Stripe is the source of truth; the `Subscription` row mirrors it.

**Plans and limits** — the single source of truth is
[`server/billing/entitlements.ts`](../server/billing/entitlements.ts) (config,
not literals scattered across the code). Prices live in Stripe and map to a tier
via env price IDs:

| Plan | Active campaigns | Discovery runs / month | LinkedIn accounts |
|---|---:|---:|---:|
| **Trial** | 1 | 10 | 1 |
| **Starter** | 2 | 25 | 1 |
| **Growth** | 10 | 150 | 3 |
| **Agency** | 100 | 2,000 | 25 |

**Trial and lapse behaviour — deliberately gentle:**

- A company with **no `Subscription` row** is treated as an **active trial**, so
  new signups are never blocked.
- 14-day trial. When it lapses, `requireEntitlement()` throws a **402** on the
  routes that **create** things.
- **Reads are never gated.** Access degrades to read-only — *"your data is safe
  and stays read-only until then."* **Never a data-losing lockout.**

---

### 7.15 Audit trail

Append-only `AuditLog`, written via `recordAudit()` inside the same Prisma
transaction as the action it records. `AuditAction` is a **typed enum**, not free
strings, so the trail stays queryable as features are added. Roughly 70 actions
are defined, covering:

- **Identity:** signup, login, logout, password reset requested/completed.
- **Workspace:** company created/updated, members added/removed, onboarding
  completed.
- **Integrations:** LinkedIn connected/disconnected/refreshed, extension token
  issued/revoked, extension action completed.
- **AI + approval:** every suggestion generated, every draft created,
  regenerated, submitted, approved, rejected, scheduled, published.
- **Outreach & leads:** signal detected, lead created/updated, outreach drafted,
  approved, sent, outcome updated.
- **Discovery, memory, campaigns, analytics, billing:** runs started/completed,
  memories generated, campaigns planned/paused/resumed, checkpoints, reports,
  checkout started, subscription lifecycle, payment failures.

Each row stores `companyId`, `userId` (both nullable, for system and pre-company
events), a free-form `metadata` JSON with the AI rationale and entity IDs, plus
IP and user agent. This exists as a **trust and explainability product feature**,
not as an ops afterthought.

---

## 8. Data model

PostgreSQL via Prisma. 30 models, designed up front for the whole roadmap so
feature work doesn't require painful migrations. Full source with inline
commentary: [`prisma/schema.prisma`](../prisma/schema.prisma).

**Identity & tenancy**
`User` · `Account` (NextAuth OAuth linkage — adding a provider needs no schema
change) · `Session` · `VerificationToken` · `PasswordResetToken` (hash-only) ·
`Company` (the tenant boundary) · `CompanyMember` (join + per-company role) ·
`AuditLog`

**Integrations**
`LinkedInConnection` (access/refresh tokens stored **encrypted**, one per
company) · `ExtensionToken` (hash-only, revocable, workspace-scoped)

**Knowledge & content**
`KnowledgeSource` · `KnowledgeChunk` · `ContentDraft` (approval lifecycle +
`aiMetadata` provenance)

**Intelligence**
`TrendDigest` (unique per company per day) · `CompanyTrendConfig` ·
`CompetitorProfile` · `CompetitorSnapshot` · `CompetitorReport` (unique per week)

**Pipeline**
`OutreachConfig` · `Lead` · `LeadSignal` · `OutreachMessage` ·
`DiscoveryProfile` · `DiscoveryRun` · `EngagementTarget` · `EngagementComment`

**Learning & business**
`PerformanceSnapshot` · `MarketingMemory` · `Campaign` · `CampaignTask` ·
`Subscription` · `AnalyticsReport`

**Modelling conventions worth knowing:**

- **`Json` columns as extension points** — `Company.preferences`,
  `ContentDraft.aiMetadata`, `TrendDigest.payload`, `Campaign.plan`,
  `DiscoveryProfile.criteria`, `MarketingMemory.supportingDataSummary`. Each has
  a documented shape and, where it matters, a Zod schema that validates it.
- **Native Postgres `text[]`** for keyword/title/stage lists.
- **Composite unique keys as idempotency guarantees** —
  `TrendDigest(companyId, date)`, `CompetitorReport(companyId, weekStart)`,
  `AnalyticsReport(companyId, periodStart)`,
  `KnowledgeSource(companyId, type, url)`,
  `EngagementTarget(companyId, profileUrl)`.
- **Cascade vs SetNull chosen deliberately** — deleting a company removes its
  data; deleting a user preserves the audit trail (`SetNull`).
- **`binaryTargets = ["native", "rhel-openssl-3.0.x"]`** so Prisma works in
  serverless (Lambda/Amazon Linux) as well as locally.
- **`DATABASE_URL` (pooled) vs `DIRECT_URL` (direct)** — migrations need a direct
  connection because PgBouncer's transaction pooling breaks the advisory locks
  `prisma migrate deploy` relies on. Setting both to the same value is always
  safe.

---

## 9. API reference

All routes live under `/api`. Every one validates its input with Zod, resolves
the session, and scopes to the active company. Errors are mapped to consistent
JSON shapes by [`lib/api.ts`](../lib/api.ts).

**Auth**

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/signup` | Create account (rate-limited) |
| `POST` | `/api/auth/forgot-password` | Issue a hashed reset token |
| `POST` | `/api/auth/reset-password` | Consume the token, set new password |
| `*` | `/api/auth/[...nextauth]` | NextAuth handler (credentials + Google) |

**Workspace**

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/api/companies` | List / create workspaces |
| `PATCH` | `/api/companies/[id]` | Update company settings |

**Knowledge & brand voice**

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/knowledge/sync` | Ingest/refresh website + blog sources |
| `POST` | `/api/knowledge/upload` | Upload `.txt` / `.md` / `.pdf` |
| `GET` `POST` `PUT` | `/api/brand-voice` | Read / generate / hand-edit the profile |

**Trends**

| Method | Route | Purpose |
|---|---|---|
| `GET` `PUT` | `/api/trends/config` | Keywords, subreddits, feeds, source toggles |
| `POST` | `/api/trends/refresh` | Generate today's digest on demand |

**Content**

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/content/generate` | Generate a draft from a brief |
| `GET` `PATCH` | `/api/content/drafts/[id]` | Read / edit a draft |
| `POST` | `/api/content/drafts/[id]/status` | Move through the state machine |
| `POST` | `/api/content/drafts/[id]/refine` | Targeted AI revision |
| `POST` | `/api/content/drafts/[id]/schedule` | Set `scheduledFor` |
| `POST` | `/api/content/drafts/[id]/publish` | Publish (approved only) |
| `POST` | `/api/content/drafts/bulk` | Bulk approve/reject |

**LinkedIn**

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/linkedin/connect` | Start OIDC flow (CSRF-protected) |
| `GET` | `/api/linkedin/callback` | Exchange code, store encrypted tokens |
| `POST` | `/api/linkedin/disconnect` | Revoke the connection |

**Competitors**

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/api/competitors` | List / add |
| `PATCH` `DELETE` | `/api/competitors/[id]` | Update / remove |
| `POST` | `/api/competitors/[id]/track` | Capture a snapshot now |
| `POST` | `/api/competitors/reports` | Generate the weekly report |

**Leads & discovery**

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/api/leads/discovery/profiles` | List / create profiles |
| `PATCH` `DELETE` | `/api/leads/discovery/profiles/[id]` | Update / delete |
| `POST` | `/api/leads/discovery/profiles/[id]/run` | Run discovery now |

**Outreach**

| Method | Route | Purpose |
|---|---|---|
| `GET` `PUT` | `/api/outreach/config` | Targeting configuration |
| `POST` | `/api/outreach/detect` | Run signal detection now |
| `GET` `POST` | `/api/outreach/leads` | List / add leads |
| `PATCH` `DELETE` | `/api/outreach/leads/[id]` | Update / remove |
| `POST` | `/api/outreach/leads/[id]/draft` | AI-draft a message |
| `PATCH` | `/api/outreach/messages/[id]` | Edit the draft text |
| `POST` | `/api/outreach/messages/[id]/status` | Approve / reject |
| `POST` | `/api/outreach/messages/[id]/outcome` | Record accepted / replied |

**Engagement**

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/api/engagement/targets` | Monitored profiles |
| `DELETE` | `/api/engagement/targets/[id]` | Remove one |

**Extension** (bearer-token auth + CORS preflight; **never** session auth)

| Method | Route | Purpose |
|---|---|---|
| `GET` `POST` | `/api/extension/token` | List / issue pairing tokens |
| `POST` | `/api/extension/token/[id]/revoke` | Revoke a token |
| `GET` | `/api/extension/status` | Health + workspace identity |
| `GET` | `/api/extension/queue` | The approved-action queue |
| `POST` | `/api/extension/actions/complete` | Sync back "I posted it" |
| `POST` | `/api/extension/engagement/draft` | Draft a comment from on-screen text |
| `POST` | `/api/extension/metrics` | Sync visible like/comment counts |

**Memory, campaigns, analytics, billing**

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/memory/generate` | Extract insights now |
| `GET` `POST` | `/api/campaigns` | List / create |
| `POST` | `/api/campaigns/orchestrate` | AI-plan the campaign |
| `POST` | `/api/campaigns/[id]/status` | Activate / pause / resume |
| `POST` | `/api/analytics/report` | Generate the written report |
| `POST` | `/api/billing/checkout` | Stripe hosted Checkout session |
| `POST` | `/api/billing/portal` | Stripe Customer Portal session |
| `POST` | `/api/webhooks/stripe` | **Signature-verified** webhook |

**Cron** — see §10.

---

## 10. Scheduled jobs (cron)

Every scheduled job is a **platform-agnostic HTTP endpoint** under `/api/cron/*`,
authorized by an `Authorization: Bearer $CRON_SECRET` header. Wire them to
anything that can POST — Vercel Cron, Netlify Scheduled Functions, Railway,
GitHub Actions, cron-job.org.

| Endpoint | Suggested cadence | What it does |
|---|---|---|
| `/api/cron/trends` | daily | Generate each company's trend digest (idempotent per day) |
| `/api/cron/publish` | every 15 min | Publish drafts whose `scheduledFor` has passed |
| `/api/cron/campaigns` | daily | Execute due campaign tasks → drafts into the approval queue |
| `/api/cron/outreach` | daily | Detect new lead signals from public sources |
| `/api/cron/discovery` | weekly | Auto-run `DiscoveryProfile`s flagged `autoRun` |
| `/api/cron/competitors` | weekly | Snapshot + diff competitors, generate the weekly report |
| `/api/cron/memory` | weekly | Extract Marketing Memory insights from real performance data |
| `/api/cron/analytics` | weekly | Generate the written analytics report |

```bash
curl -X POST https://your-app/api/cron/trends \
     -H "authorization: Bearer $CRON_SECRET"
```

---

## 11. Security model

**Authentication**
NextAuth v4 with JWT sessions signed by `NEXTAUTH_SECRET`. Passwords hashed with
bcrypt. Reset tokens are single-use, expiring, and stored **hash-only**.

**Authorization — four layers**
1. Edge middleware guards `/dashboard/*` and `/onboarding`.
2. Route handlers resolve the session and the **active company**.
3. `requireCompanyRole()` + `assertCan()` enforce the RBAC matrix.
4. `requireEntitlement()` enforces plan limits on **create** paths (never reads).

**Secrets at rest**
LinkedIn access and refresh tokens are encrypted with **AES-256-GCM**
([`lib/crypto.ts`](../lib/crypto.ts)) using `ENCRYPTION_KEY`. Extension tokens
and password-reset tokens are stored as **SHA-256 hashes only** — the raw values
are unrecoverable from the database.

**The extension token boundary**
A compromised extension token cannot escalate to account access: it authorizes
only `/api/extension/*`, is scoped to a single workspace, and is independently
revocable. `EXTENSION_ALLOWED_ORIGIN` pins the accepted origin in production.

**Tenant isolation**
Every query filters by `companyId`, with a dedicated test suite proving
cross-tenant reads fail.

**Rate limiting**
A sliding-window limiter ([`lib/rate-limit.ts`](../lib/rate-limit.ts)) protects
auth and public endpoints. It is in-memory (per-instance) — effective for a
single node, best-effort behind multiple serverless instances. The documented
production upgrade is a shared Redis/Upstash store behind the **same
`rateLimit()` interface**, so no call site changes.

**Webhooks**
Stripe webhooks are signature-verified with `STRIPE_WEBHOOK_SECRET` before any
state change.

**Input validation**
Zod on every route, before the database is touched. No exceptions.

**Monitoring**
`captureException` in [`lib/monitoring.ts`](../lib/monitoring.ts), Sentry-ready
via `SENTRY_DSN`.

---

## 12. Configuration & environment variables

Every variable is documented in [`.env.example`](../.env.example).

### Required

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL (pooled, for runtime queries) |
| `DIRECT_URL` | PostgreSQL (direct, for migrations — may equal `DATABASE_URL`) |
| `NEXTAUTH_URL` | App base URL |
| `NEXTAUTH_SECRET` | Session/JWT signing — `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | AES-256-GCM key, 32 bytes — `openssl rand -base64 32` |
| `CRON_SECRET` | Protects every `/api/cron/*` endpoint |

### Optional — every feature degrades honestly without its key

| Variable | Enables | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | All AI generation (Claude, `claude-opus-4-8`) | Falls back to Gemini, then to heuristics |
| `GEMINI_API_KEY` | AI generation via Gemini | — |
| `ANTHROPIC_MODEL` / `GEMINI_MODEL` | Model override | Defaults used |
| `GOOGLE_CLIENT_ID` / `_SECRET` | "Continue with Google" | Button not rendered |
| `LINKEDIN_CLIENT_ID` / `_SECRET` | LinkedIn Connect (official OIDC) | Connect flow hidden |
| `LINKEDIN_ORG_URN` / `LINKEDIN_API_VERSION` | Company-page auto-publish (needs Community Management approval) | Manual-copy fallback |
| `REDDIT_CLIENT_ID` / `_SECRET` / `_USER_AGENT` | Reddit trend source | Source reported as skipped |
| `TWITTER_BEARER_TOKEN` | X/Twitter trend source | Off by default |
| `GITHUB_TOKEN` | Higher GitHub rate limits | Keyless (lower limits) |
| `CRUNCHBASE_API_KEY` | Funding signals | Source skipped, with reason |
| `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` | Web-search lead discovery | Source skipped |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/_GROWTH/_AGENCY` | Billing | Billing UI disabled |
| `EXTENSION_ALLOWED_ORIGIN` | Pins the published extension origin | Dev origins accepted |
| `SENTRY_DSN` | Error monitoring | Console logging |
| `RESEND_*` | Real email delivery | `lib/email.ts` logs to console |

**Hacker News and Google News need no credentials** — trend intelligence works
out of the box.

---

## 13. Running it locally

**Prerequisites:** Node ≥ 20, pnpm ≥ 9, PostgreSQL (or use the bundled
`docker-compose.yml`).

```bash
pnpm install                    # 1. dependencies (runs prisma generate)
docker compose up -d            # 2. Postgres — skip if you have your own
cp .env.example .env            # 3. configure; generate the two secrets
pnpm db:migrate                 # 4. apply migrations
pnpm db:seed                    # 5. demo user + company
pnpm dev                        # 6. → http://localhost:3000
```

**Demo login:** `demo@botella.ai` / `Password123`

**Load the extension:** `chrome://extensions` → Developer mode → **Load
unpacked** → select `extension/`. Then pair it from **Settings → Browser
extension**.

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm build` | Production build (`prisma generate` first) |
| `pnpm start` | Serve the production build |
| `pnpm start:prod` | `prisma migrate deploy` then serve (Railway) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm test` / `test:watch` | Vitest |
| `pnpm format` / `format:check` | Prettier |
| `pnpm db:migrate` / `db:migrate:deploy` | Migrations (dev / prod) |
| `pnpm db:push` | Push schema without a migration |
| `pnpm db:seed` | Seed demo data |
| `pnpm db:studio` | Prisma Studio |

---

## 14. Deployment

A single Next.js deployable. The repo ships configs for **Vercel**
(`vercel-build`), **Netlify** (`netlify.toml`), and **Railway** (`railway.json` +
`start:prod`).

**Migration strategy differs by platform, deliberately:**

- **Vercel:** `vercel-build` runs `prisma generate && next build` only —
  migrations do **not** run during the build (builds can run without direct DB
  access). Apply them separately.
- **Railway:** `start:prod` runs `prisma migrate deploy` at start.
- **Netlify:** `netlify:build` runs generate + deploy + build.

**Go-live checklist:**

1. Set all required secrets (§12).
2. Run `pnpm db:migrate:deploy` against production (verified to apply cleanly on
   a fresh database).
3. Point the Stripe webhook at `/api/webhooks/stripe` and set its signing secret.
4. Wire the eight `/api/cron/*` endpoints to a scheduler with `CRON_SECRET`.
5. Set `EXTENSION_ALLOWED_ORIGIN` if shipping a published extension.

**Chrome Web Store submission** (manual, one-time — checklist in
[`extension/README.md`](../extension/README.md)): `cd extension && npm run zip`,
swap the localhost host permission for your production domain, add 16/48/128px
icons, write the privacy policy and permissions justification, and add
screenshots. The extension requests only `storage` + `activeTab` and two host
permissions — no `tabs`, no `<all_urls>`.

---

## 15. Testing & quality gates

**Gates:** `pnpm typecheck` (strict), `pnpm lint`, `pnpm test`, `pnpm format:check`.

**Vitest suites** ([`tests/`](../tests/)) — 18 files, deliberately targeting the
logic where a bug would be expensive or invisible:

| Suite | What it protects |
|---|---|
| `approval-state-machine.test.ts` | **The human-in-the-loop guarantee** — no path to PUBLISHED except via APPROVED |
| `tenant-isolation.test.ts` | **Multi-tenant isolation** — company B can't read company A |
| `billing.test.ts` | Plan entitlements, trial expiry, read-only degradation |
| `crypto.test.ts` | AES-256-GCM round-trip + token hashing |
| `password.test.ts` | bcrypt hash/verify |
| `extension-token.test.ts` | Token issue/hash/revoke semantics |
| `content-schemas.test.ts` | Per-type content output schemas |
| `campaign-plan.test.ts` | Campaign plan validation |
| `claude.test.ts` | JSON extraction, fence tolerance, structured retry |
| `scoring.test.ts` | Pure trend scoring against fixtures |
| `retrieve.test.ts` | Knowledge retrieval ranking |
| `lead-dedup.test.ts` | Discovered leads never duplicate existing ones |
| `outreach-matching.test.ts` | Signal → criteria matching |
| `competitor-diff.test.ts` | Change detection and diffing |
| `marketing-memory.test.ts` | **The "not enough data" honesty rule** + confidence tiers |
| `hackernews-source.test.ts` | Source parsing |
| `company-service.test.ts`, `validations.test.ts` | Services and Zod schemas |

Pure functions (scoring, diffing, chunking, metrics, dedup) are deliberately
kept I/O-free and take injected clocks so they are testable with fixtures.

---

## 16. Design system

Full spec: [`DESIGN.md`](../DESIGN.md).

**Aesthetic target:** the calm, confident, high-signal feel of Linear / Vercel /
Notion — generous whitespace, subtle layered shadows, one confident accent.

- **Color:** neutral slate surfaces + a single indigo-violet accent ("Aura",
  `250 84% 60%`). All tokens are **HSL CSS variables** in
  [`app/globals.css`](../app/globals.css), surfaced to Tailwind. Never hard-code
  a hex in a component — one edit re-themes the product and dark mode comes free.
- **Status colors map to the content lifecycle:** `DRAFT` → muted,
  `PENDING_APPROVAL` → warning, `APPROVED` → primary, `REJECTED` → destructive,
  `PUBLISHED` → success.
- **Typography:** Inter via `next/font`. Page titles `text-2xl font-semibold`;
  section titles `text-lg`; body `text-sm`; helpers `text-xs text-muted-foreground`.
- **Spacing/radius/elevation:** Tailwind's 4px scale; `--radius: 0.75rem`; four
  soft cool shadows where elevation communicates layering, never decoration.
- **Accessibility baseline:** semantic HTML, every input has a `<Label htmlFor>`,
  errors use `aria-invalid` + `role="alert"`, visible `:focus-visible` rings
  everywhere, Radix dialogs are focus-trapped, and **color is never the sole
  signal** — status badges pair color with text.
- **Components:** primitives in [`components/ui/`](../components/ui/) follow the
  shadcn/ui pattern (Radix + `class-variance-authority` + a `cn()` merge helper),
  with a `variant`/`size` API, forwarded refs, and `className` passthrough.
  Feature-specific composition lives in `components/dashboard/<module>/`.

---

## 17. What it deliberately does NOT do

Being explicit about this is part of the product.

| Not done | Why |
|---|---|
| **Auto-post, auto-connect, auto-comment** | The entire safety thesis. Every LinkedIn action is a human click in a human's own browser. |
| **Scrape LinkedIn** | No unofficial endpoints, no headless browsers, no cookie replay. The backend never contacts linkedin.com on your behalf. |
| **Auto-publish to a Company Page** | Requires LinkedIn's Community Management API approval + `w_organization_social` + an org URN. The code is wired and waiting; until then, the manual-copy fallback is used and honestly labelled. |
| **Read the LinkedIn feed or a competitor's company page** | No official API scope exists. Flagged as a stub in code and in the UI rather than faked. |
| **Fabricate metrics or insights** | Below 10 measured posts, Marketing Memory says so. Analytics reports `hasData: false`. A publish is only "published" when a real API call succeeded. |
| **Semantic/vector retrieval** | Current retrieval is keyword + recency. Embeddings are a documented backlog item behind the same `retrieve()` interface. |
| **Real email delivery (out of the box)** | `lib/email.ts` logs to console; swap in Resend with no call-site changes. |
| **Distributed rate limiting** | In-memory per instance today; Redis upgrade documented behind the same interface. |

---

## 18. Glossary

| Term | Meaning |
|---|---|
| **Workspace / Company** | The tenant boundary. Everything the AI produces is scoped to one. |
| **Knowledge Base** | The company's own ingested material (site, blog, uploads, past posts) that grounds generation. |
| **Brand Voice Profile** | The AI-analyzed, human-editable description of how the company sounds. Injected into every prompt. |
| **Trend Digest** | The daily scored list of what the market is talking about. One per company per day. |
| **Content Draft** | A generated artifact moving through the approval state machine. |
| **Approval gate** | The human decision that must happen before anything leaves the system. |
| **Action Queue** | The list of approved items the Chrome Extension shows you to send. |
| **Lead** | A prospect organization, from a `SIGNAL`, the `DISCOVERY_ENGINE`, or added `MANUAL`ly. |
| **Signal** | A public buying indicator — funding, hiring, GitHub activity, news, leadership change. |
| **Discovery Profile** | A saved, reusable description of who you want to reach. |
| **Performance Snapshot** | A real, measured engagement data point. Never estimated. |
| **Marketing Memory** | An evidence-backed learned insight, injected into future generations. |
| **Campaign Task** | One scheduled unit of campaign work that triggers an existing pipeline. |
| **Entitlement** | A plan-based limit checked on create paths only — never on reads. |
| **Audit Log** | The typed, append-only record of every meaningful action. |

---

*This document describes the shipped state of Botella Aura across all six
development sprints. For per-sprint implementation detail see
[`docs/SPRINT-1-TECHNICAL.md`](SPRINT-1-TECHNICAL.md) through
[`SPRINT-6-TECHNICAL.md`](SPRINT-6-TECHNICAL.md); for setup and deployment see
the [README](../README.md); for visual conventions see [DESIGN.md](../DESIGN.md).*
