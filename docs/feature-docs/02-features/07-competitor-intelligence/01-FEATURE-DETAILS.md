# Competitor Intelligence

> Competitor Intelligence lets a workspace keep a short list of competitors and watch what they do in public: changes to their homepage and pricing page, news that names them, and activity on their public GitHub org. Each tracking run stores a snapshot with a plain-English summary of what changed. Once a week those snapshots become an AI-written report with one section per competitor and an overall "what this means for you" synthesis. It exists so a marketing team can react to a rival's move (a new tier, a price cut, a launch) without checking their sites by hand. It also feeds Aura's Signals, Weekly Briefing and Home. Only public sources are used. The LinkedIn company feed is a deliberate stub, not a scraper.

## 1. Overview

- **What it tracks per competitor** (`CompetitorProfile`): name, homepage URL, pricing page URL, LinkedIn company page URL (display only), GitHub org/user login, free-text notes, and a `trackingEnabled` flag.
- **Sources** (`server/competitors/sources/`):
  - `website.ts`: robots.txt-respecting fetch of the homepage and pricing page, turned into readable text.
  - `news.ts`: keyless Google News search RSS for the competitor's name.
  - `github.ts`: the official GitHub REST API (profile, recently pushed repos, latest release).
  - `linkedin.ts`: an intentional stub that always reports "unavailable" and why.
- **Change detection** (`server/competitors/diff.ts`):
  - Deterministic normalize, hash and line-diff functions.
  - An AI call happens only when the hash changed. It writes a 1-2 sentence summary.
  - On the first capture, an AI "positioning" summary is written instead.
- **Weekly report** (`server/competitors/report.service.ts`):
  - Collects the ISO week's snapshots and asks the AI layer for a structured report.
  - Upserts one `CompetitorReport` per `(companyId, weekStart)`.
  - Falls back to a deterministic report when no AI provider is configured or the call fails.
- **Transparency.** Every snapshot records which sources were `skipped` and why. Every report section carries `coverage` (snapshots, sources checked, sources skipped, baseline-only). An empty week therefore reads differently from a broken pipeline.

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
|---|---|---|---|
| Competitor Intelligence | `/dashboard/competitors` (`app/dashboard/competitors/page.tsx`) | See every tracked competitor as a card: link pills (Website, Pricing, LinkedIn, GitHub), a "Paused" badge when tracking is off, and the latest snapshot. The snapshot shows a baseline, detected changes or "no change", up to 3 recent news items, the GitHub latest release, and the skipped sources. Managers can add, edit or remove a competitor (removal asks for confirmation: "This deletes its tracking history") and press **Track now**. | View: any member. Manage: OWNER, ADMIN (`company:update`). |
| Weekly competitor reports | `/dashboard/competitors/reports` (`app/dashboard/competitors/reports/page.tsx`) | Read the selected week's report: the synthesis, then one card per competitor with new launches, pricing changes, notable activity and a strategic takeaway. Empty sections explain their coverage. Switch weeks with `?week=YYYY-MM-DD` chips (up to 12 stored weeks). Managers see **Generate now** (or **Generate first report** in the empty state). | View: any member. Generate: OWNER, ADMIN. |

UI details taken from the code:

- **Nudge banner.** Shown to managers when fewer than 3 competitors are tracked. With 0 it says "Add your first competitor". Otherwise it says "Track N more competitor(s)", because patterns only show up in comparison.
- **Add/Edit dialog** (`competitor-manager.tsx`):
  - Fields: Name (required), Website (homepage), Pricing page URL, LinkedIn page, GitHub org, Notes.
  - The LinkedIn URL is checked on the client with `classifyLinkedInUrl` from `lib/linkedin-url.ts` and must be a `linkedin.com/company/…` page.
  - The dialog does **not** expose `trackingEnabled`. That flag can only be changed through `PATCH /api/competitors/:id`.
- **Track now** toasts "Snapshot captured — changes detected." when `hasChanges` is true. Otherwise it toasts "Snapshot captured."
- **AI-free notice.** When a report's `model` is `'none'`, the report view says it was "Generated without AI (no ANTHROPIC_API_KEY)".
- **Navigation.** The sidebar entry "Competitors" is in group `market` in `lib/nav.ts`, with the description "What your competitors changed this week, and what it means for you."

## 3. How it works

### 3.1 Tracking pass (one competitor): `trackCompetitor` in `tracking.service.ts`

1. Load the competitor with its latest snapshot. If the competitor is missing or `trackingEnabled` is false, return `null`. The track route turns `null` into a 409 response.
2. **Pages**: `trackPage` runs for the homepage (`url`) and the pricing page (`pricingUrl`) in parallel.
   - If no URL is set, the page is skipped silently.
   - `capturePage` calls `politeFetchHtml` from `server/knowledge/robots.ts`. That function checks robots.txt, waits a 1200 ms throttle, and fetches with a 10 s timeout and 1 retry, using the user agent `BotellaAuraBot/0.1`. The HTML then goes through `htmlToText`, and the text is trimmed to **20,000 chars** (`MAX_TEXT_CHARS`).
   - If the fetch fails or there is no text, the page keeps the previous hash and text. A reason is recorded in `skipped`: `"<page>: not fetched (robots.txt or unreachable)"` or `"<page>: no readable text"`.
   - `hashText` is the SHA-256 of `normalizeText`, which collapses whitespace per line and drops empty lines.
   - **First capture** (no previous hash): `summarizePositioning` records what the page says now, which becomes the `baseline`. Nothing is marked as changed.
   - **Unchanged hash**: no AI call is made.
   - **Changed hash**: `diffTexts` runs a set-based line diff. Lines of 2 characters or fewer are ignored, and each of `added` and `removed` is capped at 40 lines. `summarizeChange` then asks the AI for 1-2 sentences, sending at most 30 added and 30 removed lines.
3. **News**: `fetchCompetitorNews(name)` queries `https://news.google.com/rss/search?q="<name>"&hl=en-US&gl=US&ceid=US:en`. The request has an 8 s timeout and 1 retry. Results are kept only if:
   - they are no older than 10 days (`FRESHNESS_DAYS`),
   - the title contains the competitor name (case-insensitive),
   - the link has not been seen already (dedupe by link).
   At most 8 items are kept (`MAX_ITEMS`). Errors return `[]`.
4. **GitHub**: `fetchGitHubSignal(githubOrg)` runs only if `githubOrg` is set.
   - It calls `GET /users/{org}` and `GET /users/{org}/repos?sort=pushed&direction=desc&per_page=8`, each with an 8 s timeout. The 5 most recently pushed repos are kept.
   - It then looks up `releases/latest` for the top repo. A 404 is ignored.
   - It returns `null` when nothing public is found. The tracker then records `"github: org not found or unreachable"` in `skipped`.
5. **LinkedIn**: if `linkedInUrl` is set, `fetchLinkedInCompanySignal` always returns `available: false`. Its reason ("…require an official API scope we do not yet have (no scraping)…") is pushed to `skipped`.
6. Build a `ChangesSummary` with these fields:
   - `hasChanges`, plus the `homepage` and `pricing` summaries
   - `news`, `github` and `skipped`
   - `model`: the first non-`'none'` model of homepage, then pricing
   - `capturedAt`, and `isBaseline` / `baseline` on a first capture
7. In one transaction, create the `CompetitorSnapshot` (hashes, texts and `changesSummary`) and audit `COMPETITOR_SNAPSHOT_CAPTURED` with `hasChanges` and `newsCount`. Return `{ snapshotId, hasChanges }`.

`trackCompany(companyId)` runs `trackCompetitor` **one competitor at a time** for every competitor with `trackingEnabled: true`. A failure is logged and counted, and the loop moves on. It returns `{ tracked, changed, failed }`.

### 3.2 AI summaries and fallbacks (`diff.ts`)

- `summarizeChange` uses `completeStructured` with `maxTokens: 400`, `effort: 'low'` and `tier: 'cheap'`. The model returns JSON `{ summary }`.
  - If `isClaudeConfigured()` is false (neither Anthropic nor Gemini is configured) or the call throws, it falls back to `deterministicSummary`. That produces text like `The pricing page changed — 2 new line(s) added, 1 line(s) removed. e.g. "…"`, with a preview of up to 120 characters.
- `summarizePositioning` also uses the `cheap` tier with 400 tokens. It sends at most 4,000 characters of normalized page text.
  - Its fallback `deterministicPositioning` takes the first 3 lines of 25 or more characters, up to 300 characters in total.
  - If there are no such lines, it returns "Baseline captured for the … — we'll report changes from the next run."
- The recorded provenance `model` is `DEFAULT_MODEL` (`'claude-opus-4-8'`) after a successful AI call and `'none'` otherwise.

### 3.3 Weekly report: `generateWeeklyReport` in `report.service.ts`

1. `weekStart = startOfIsoWeekUTC(now)` is Monday 00:00 UTC, and `weekEnd = weekStart + 7 days`. The service audits `COMPETITOR_REPORT_REQUESTED`.
2. Load all of the company's competitors, regardless of `trackingEnabled`, with snapshots where `capturedAt` is in `[weekStart, weekEnd)`.
3. `collectSignal` merges each competitor's snapshots into:
   - homepage and pricing change summaries
   - news, deduplicated by URL
   - GitHub lines: the latest release, plus up to 3 recently pushed repos ("Active development in …")
   - baseline positioning
   - `coverage`
4. `buildPayload`:
   - **No AI provider configured, or zero competitors**: use `deterministicReport`.
     - New launches are the GitHub lines plus the first 3 news titles.
     - Notable activity is homepage changes, baselines, and news titles 4-6.
     - The synthesis says "N of M tracked competitors showed public activity…", or that nothing changed, or (with `noCompetitors: true`) that none are tracked yet.
   - **Otherwise**: one `completeStructured` call with `maxTokens: 2000`, `effort: 'medium'` and `tier: 'standard'`. The schema is `{ competitors[{competitor,newLaunches[],pricingChanges[],notableActivity[],strategicTakeaway}], synthesis }`.
     - Entries are matched back to competitor ids **by lower-cased, trimmed name**.
     - Any captured baseline the model left out is added back into `notableActivity`.
     - Empty sections get `emptyTakeaway`: "Not tracked yet this week…", "First snapshot captured…", "We checked … Some sources were unavailable…", or "…nothing material changed this week."
     - If the call throws, the deterministic report is used.
5. Upsert `CompetitorReport` on `companyId_weekStart`, so regenerating the same week overwrites `payload`, `model` and `generatedAt`. Then audit `COMPETITOR_REPORT_GENERATED` with `reportId`, the competitor count and `model`.

`listReports` returns the newest **12** reports. `getReport` is scoped by company.

### 3.4 Defensive reading of stored JSON

`readChangesSummary` in `types.ts` normalizes a stored `changesSummary` so that `news` and `skipped` are always arrays and `model` defaults to `'none'`. Older snapshots and seed fixtures lacked these fields, which once crashed the Competitors page. The test `tests/stored-payload-tolerance.test.ts` covers this.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | `app/dashboard/competitors/page.tsx` | Server page: resolves the active company and `canManage`, maps competitors and their latest snapshot (via `readChangesSummary`) to `CompetitorRow`, shows the fewer-than-3 nudge. |
| Page | `app/dashboard/competitors/reports/page.tsx` | Server page: lists reports, selects one by `?week=`, shows week chips, `ReportView`, and `GenerateReportButton`. |
| Component | `components/dashboard/competitors/competitor-manager.tsx` | Client: add/edit dialog, remove, Track now, competitor cards, latest-snapshot rendering. |
| Component | `components/dashboard/competitors/report-view.tsx` | Client: synthesis card, per-competitor sections, `EmptyExplainer` built from `coverage`. |
| Component | `components/dashboard/competitors/generate-report-button.tsx` | Client: `POST /api/competitors/reports`, then `router.refresh()`. |
| API | `app/api/competitors/route.ts` | `GET` list, `POST` create. |
| API | `app/api/competitors/[id]/route.ts` | `PATCH` update, `DELETE` remove. |
| API | `app/api/competitors/[id]/track/route.ts` | `POST` one tracking pass (`maxDuration = 60`). |
| API | `app/api/competitors/reports/route.ts` | `POST` track all, then generate this week's report (`maxDuration = 60`). |
| Cron | `app/api/cron/competitors/route.ts` | `GET`/`POST`: for every company, `trackCompany` then `generateWeeklyReport`. Requires `Bearer CRON_SECRET`. |
| Service | `server/competitors/competitor.service.ts` | `listCompetitors`, `getCompetitorOrThrow` (`CompetitorNotFoundError`, 404), `addCompetitor`, `updateCompetitor`, `removeCompetitor`. All writes are audited in a transaction. |
| Service | `server/competitors/tracking.service.ts` | `trackCompetitor`, `trackCompany`. |
| Service | `server/competitors/report.service.ts` | `generateWeeklyReport`, `listReports`, `getReport`, `startOfIsoWeekUTC`. |
| Lib | `server/competitors/diff.ts` | `normalizeText`, `hashText`, `diffTexts`, `summarizeChange`, `deterministicSummary`, `summarizePositioning`, `deterministicPositioning`. |
| Lib | `server/competitors/types.ts` | `ChangesSummary`, `GitHubSignal`, `CompetitorNewsItem`, `CompetitorReportEntry`, `CompetitorCoverage`, `CompetitorReportPayload`, `readChangesSummary`. |
| Source | `server/competitors/sources/website.ts` | `capturePage` (uses `politeFetchHtml` and `htmlToText` from `server/knowledge/`). |
| Source | `server/competitors/sources/news.ts` | `fetchCompetitorNews` (Google News RSS via `fast-xml-parser`). |
| Source | `server/competitors/sources/github.ts` | `fetchGitHubSignal` (GitHub REST API). |
| Source | `server/competitors/sources/linkedin.ts` | `fetchLinkedInCompanySignal`, a permanent "unavailable" stub. |
| Validation | `lib/validations/competitors.ts` | `createCompetitorSchema`, `updateCompetitorSchema`. |
| Tests | `tests/competitor-diff.test.ts` | 12 tests: `normalizeText`, `hashText`, `diffTexts`, `deterministicSummary`, `startOfIsoWeekUTC`. |
| Tests | `tests/stored-payload-tolerance.test.ts` | `readChangesSummary` tolerates legacy or empty JSON. |

## 5. Data model

All models are in `prisma/schema.prisma`.

**`CompetitorProfile`** (owned)

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `companyId` | String | FK to `Company`, `onDelete: Cascade` |
| `name` | String | 2-120 chars (validation) |
| `url` | String? | Homepage, tracked for changes |
| `pricingUrl` | String? | Tracked separately |
| `linkedInUrl` | String? | Display only (source is a stub) |
| `githubOrg` | String? | GitHub login, at most 39 chars |
| `notes` | String? (Text) | At most 2000 chars |
| `trackingEnabled` | Boolean, default `true` | `false` makes the tracker skip the competitor |
| `createdAt`, `updatedAt` | DateTime | |

Indexes: `[companyId]`, `[companyId, createdAt]`.

**`CompetitorSnapshot`** (owned)

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `competitorId` | String | FK to `CompetitorProfile`, `onDelete: Cascade` |
| `capturedAt` | DateTime, default `now()` | |
| `homepageHash`, `pricingHash` | String? | SHA-256 of the normalized text |
| `homepageText`, `pricingText` | String? (Text) | Text kept for the next diff, at most 20,000 chars |
| `changesSummary` | Json, default `{}` | `ChangesSummary`: `hasChanges`, `homepage?`, `pricing?`, `news[]`, `github?`, `skipped[]`, `model`, `capturedAt`, `isBaseline?`, `baseline?{homepage?,pricing?}` |
| `createdAt` | DateTime | |

Index: `[competitorId, capturedAt]`.

**`CompetitorReport`** (owned)

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `companyId` | String | FK to `Company`, `onDelete: Cascade` |
| `weekStart` | DateTime | Monday 00:00 UTC. Idempotency key. |
| `weekEnd` | DateTime | `weekStart` + 7 days |
| `payload` | Json, default `{}` | `CompetitorReportPayload`: `competitors[]` (with `competitorId`, `coverage`), `synthesis`, `noCompetitors?`, `weekStart`, `weekEnd`, `generatedAt`, `model` |
| `model` | String? | `'claude-opus-4-8'` or `'none'` |
| `generatedAt`, `createdAt` | DateTime | |

Constraints: `@@unique([companyId, weekStart])` and `@@index([companyId, weekStart])`.

**Other models used**

- `AuditAction` enum values: `COMPETITOR_ADDED`, `COMPETITOR_UPDATED`, `COMPETITOR_REMOVED`, `COMPETITOR_SNAPSHOT_CAPTURED`, `COMPETITOR_REPORT_REQUESTED`, `COMPETITOR_REPORT_GENERATED`.
- `TrendConfig.competitorNames` (`String[]`) is a separate lightweight name list used by Trend Insights. It is not linked to `CompetitorProfile`.

## 6. API endpoints

See also [Internal API reference](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| GET | `/api/competitors` | List the active company's competitors, each with its latest snapshot. Returns `{ competitors }`. | Session + active company (any member) |
| POST | `/api/competitors` | Create a competitor (`createCompetitorSchema`). Returns `201 { id, name }`. | `company:update` (OWNER, ADMIN), else 403 |
| PATCH | `/api/competitors/:id` | Partial update, including `trackingEnabled`. Returns `{ id, name }`. Returns 404 if the id is not in the company. | `company:update` |
| DELETE | `/api/competitors/:id` | Remove the competitor (snapshots cascade). Returns `{ ok: true }`. | `company:update` |
| POST | `/api/competitors/:id/track` | Run one tracking pass now. Returns `{ snapshotId, hasChanges }`, or 409 "Tracking is disabled for this competitor." | `company:update` |
| POST | `/api/competitors/reports` | "Generate now": `trackCompany` and then `generateWeeklyReport`. Returns `201 { id, weekStart }`. | `company:update` |
| GET, POST | `/api/cron/competitors` | Weekly job over all companies. Returns `{ processed, ok, failed }`. | `Authorization: Bearer $CRON_SECRET` (fails closed: 401 when the secret is unset) |

Errors use `handleRouteError` from `lib/api.ts`. Zod errors return 400, and errors that carry a `status` (such as `CompetitorNotFoundError`, 404) are passed through with that status.

## 7. External services

| Service | Used by | Notes |
|---|---|---|
| Competitor websites | `sources/website.ts` | Fetched only when robots.txt allows. 1200 ms throttle, 10 s timeout. |
| Google News RSS (`news.google.com/rss/search`) | `sources/news.ts` | Keyless. 8 s timeout, 1 retry. |
| GitHub REST API (`api.github.com`) | `sources/github.ts` | 60 req/hr without a token. `GITHUB_TOKEN` raises this to 5000/hr. API version header `2022-11-28`. |
| AI layer (Anthropic, or Gemini as fallback) | `diff.ts`, `report.service.ts` via `server/ai/claude.ts` | Uses the `cheap` tier for change and positioning summaries and the `standard` tier for the weekly report. Without a provider, deterministic text is used. |

Environment variables: `ANTHROPIC_API_KEY` (or the Gemini configuration the AI layer accepts), `GITHUB_TOKEN` (optional) and `CRON_SECRET`. See [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

- **`/api/cron/competitors`** (`app/api/cron/competitors/route.ts`)
  - Runs sequentially over every `Company`: `trackCompany(id)` and then `generateWeeklyReport({ companyId: id })`.
  - If one company fails, the failure is logged and counted, and the job continues.
  - `maxDuration = 60`. `GET` is aliased to `POST` because Vercel Cron invokes jobs with GET.
  - A comment in the file suggests the schedule `"0 13 * * 1"` (Mondays). However, **`vercel.json` does not currently list this path.** Its crons are `publish`, `briefing` and `connections` only. So on Vercel, weekly tracking runs only if another scheduler calls the endpoint. Otherwise it runs only when a manager presses **Generate now**.
- **Downstream readers** (no extra job): `server/signals/signal.service.ts` (source `COMPETITORS`, tracking-enabled competitors' recent snapshots), `server/briefing/briefing.service.ts` (`buildCompetitorMoves` from the latest `CompetitorReport`), `server/home/home.service.ts` (recent snapshots in the activity feed), plus readiness and intelligence counters.

## 9. Security & permissions

- **RBAC.** Reads need only an active-company membership (`requireActiveCompany`). Every mutation, the track route and report generation check `can(membership.role, 'company:update')`, which `lib/rbac.ts` grants only to OWNER and ADMIN. MEMBER and VIEWER get 403. The pages hide the manage controls in the same way (`canManage`).
- **Workspace scoping.**
  - All list and report queries filter by `companyId`.
  - Update, delete and track call `getCompetitorOrThrow(companyId, id)` first, so an id from another workspace gets a 404.
  - `trackCompetitor` itself loads by id only, so its callers must check scope first.
- **Validation** (`lib/validations/competitors.ts`):
  - `name` must be 2-120 chars.
  - URLs must be at most 300 chars and match a domain-or-URL regex. A missing `https://` is added.
  - `githubOrg` must match GitHub's login rule (at most 39 chars, alphanumerics and hyphens).
  - `notes` must be at most 2000 chars.
  - Empty strings are cleared to `null`.
- **Audit.** Every add, update (with `changedFields`), remove, snapshot, report request and report generation writes an audit row with the request IP and user agent where available.
- **Source safety.** Only public sources are used. There is no headless browser and no auth bypass. robots.txt is honoured, and LinkedIn is never fetched.
- **Cron.** Fails closed without `CRON_SECRET`.

## 10. Testing

- `tests/competitor-diff.test.ts` has 12 unit tests:
  - whitespace normalization
  - hash stability, and equality with a raw SHA-256
  - `diffTexts`: first capture counts as no change, identical text counts as no change, added and removed lines are detected, the sample is bounded
  - `deterministicSummary`
  - `startOfIsoWeekUTC`, including the Sunday edge case
- `tests/stored-payload-tolerance.test.ts` checks that `readChangesSummary` never throws on legacy or empty `changesSummary` JSON.
- Many `pnpm verify:*` scripts seed `CompetitorProfile` and `CompetitorSnapshot` rows as fixtures for downstream features rather than testing this module directly. Examples: `verify:signals`, `verify:detection`, `verify:opportunities`, `verify:access` (cross-tenant isolation of a competitor-derived opportunity), `verify:recommendations` and `verify:what-matters`. No `verify:*` script exercises `/api/competitors` itself.

## 11. Configuration & limits

| Setting | Value | Where |
|---|---|---|
| Max page text kept | 20,000 chars | `sources/website.ts` `MAX_TEXT_CHARS` |
| Polite fetch throttle / timeout | 1200 ms / 10 s, 1 retry | `server/knowledge/robots.ts` |
| Diff sample per side | 40 lines (30 sent to AI) | `diff.ts` |
| Positioning prompt text | 4,000 chars | `diff.ts` |
| News freshness / max items | 10 days / 8 | `sources/news.ts` |
| GitHub repos fetched / kept | 8 / 5 (3 surfaced in report) | `sources/github.ts`, `report.service.ts` |
| GitHub request timeout | 8 s | `sources/github.ts` |
| Change/positioning AI | `cheap` tier, 400 tokens, effort `low` | `diff.ts` |
| Weekly report AI | `standard` tier, 2000 tokens, effort `medium` | `report.service.ts` |
| Reports listed | 12 most recent | `listReports` |
| Route max duration | 60 s (track, reports, cron) | route files |
| Nudge threshold | fewer than 3 competitors | `app/dashboard/competitors/page.tsx` |
| Env | `ANTHROPIC_API_KEY` (or Gemini), `GITHUB_TOKEN`, `CRON_SECRET` | see section 7 |

## 12. Known limitations & future work

- **LinkedIn company posts are not collected.** The source is a stub until an official API scope is granted (Marketing Developer Platform / Community Management). The pipeline already lists it in `skipped`.
- **The weekly cron is not scheduled in `vercel.json`.** See section 8.
- **No UI toggle for `trackingEnabled`.** The flag can only be changed through the API, although the UI shows a "Paused" badge.
- **"Generate now" may hit the time limit.** It tracks every competitor one after another inside a single 60 s request, so workspaces with many competitors or slow sites can exceed `maxDuration`.
- **Report sections are matched to competitors by name.** If two competitors have the same name, the model's sections may be attributed ambiguously.
- **The recorded `model` may not be the model that ran.** It is always `DEFAULT_MODEL` (`claude-opus-4-8`) after any successful AI call, even though the calls use the `cheap`/`standard` tiers or Gemini.
- **The diff ignores order.** It is set-based per line, so reordered or duplicated lines are not detected as changes.
- **The news filter misses some mentions.** It requires the exact competitor name in the headline.

## 13. Related documents

- [SPRINT-4-TECHNICAL.md](../../../SPRINT-4-TECHNICAL.md), section 4 (Module 1 — Competitor Intelligence)
- [PRODUCT-DOCUMENTATION.md](../../../PRODUCT-DOCUMENTATION.md), section 7.10
- [SIGNAL-AGGREGATION.md](../../../SIGNAL-AGGREGATION.md)
- [OPPORTUNITY-DETECTION-RULES.md](../../../OPPORTUNITY-DETECTION-RULES.md)
- [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md)
- Sibling features: [05 Business Context](../05-business-context/), [06 Trend Insights](../06-trend-insights/), [08 Signals & Opportunities](../08-signals-and-opportunities/), [10 Aura Home & Briefing](../10-aura-home-and-briefing/), [04 Knowledge Base](../04-knowledge-base-and-brand-voice/) (polite fetcher), [23 AI Layer](../23-ai-layer/), [24 Platform Jobs & Deployment](../24-platform-jobs-and-deployment/)
- [Architecture](./02-ARCHITECTURE.md)
