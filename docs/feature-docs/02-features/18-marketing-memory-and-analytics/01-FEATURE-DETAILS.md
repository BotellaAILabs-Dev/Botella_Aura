# Marketing Memory & Analytics

> Marketing Memory and Analytics close Aura's measurement loop. Real performance numbers (synced by the Chrome extension, collected from Meta, or typed in by hand) are stored as `PerformanceSnapshot` rows. **Analytics** ("Results", `/dashboard/analytics`) shows them as top-line counts, trends, an outreach funnel and a weekly written report a founder can forward. **Marketing Memory** ("What works for you", `/dashboard/memory`) turns the same numbers into a small set of data-backed patterns (format, length, timing). Those patterns are fed back into content, planning, outreach and recommendation prompts, so later drafts follow what has actually worked for this account. Both halves refuse to make up numbers. Below a real data threshold they say "not enough data" instead of guessing.

## 1. Overview

The feature has two halves that read from the same data:

| Half | Question it answers | Main service | Stored output |
|---|---|---|---|
| Analytics (Results) | "What happened?" | `server/analytics/analytics.service.ts` (`getAnalytics`) | Nothing for the live view; weekly `AnalyticsReport` rows |
| Marketing Memory (What works for you) | "What should we do more of?" | `server/memory/extraction.service.ts` (`generateMemories`) | `MarketingMemory` rows |

Both read from `getContentPerformance(companyId)` in `server/memory/performance.service.ts`. It returns every published `ContentDraft` that has at least one `PerformanceSnapshot`, keeps only the latest snapshot per draft, and scores each one with `engagementScore`.

History: Marketing Memory was added in Sprint 5 (commit `8755674`), Analytics in Sprint 6 (`584923e`). Later commits added insight correction and dismissal (`8e2daed`), more reliable extension metric matching (`cbb746b`), the "What works for you" / "Results" naming (`b1b1e29`) and traceability rows (`c39a554`).

## 2. User-facing behaviour

### Pages

| Route | Nav label (`lib/nav.ts`) | Who can view | What the user sees and does |
|---|---|---|---|
| `/dashboard/analytics` | "Results" (group `results`) | Any member of the active company | **Range switch** of 7d / 30d / 90d (`?days=`; any other value falls back to 30). **Seven stat cards**: Posts published, Total engagement, Outreach sent, Connections made, Replies received, Leads discovered, Campaigns started. **Charts**: an engagement-over-time line chart, an Outreach funnel (Sent → Connected → Replied) and a "By content type" bar list with average engagement. **Weekly report card**: the latest `AnalyticsReport` summary. **Log results**: OWNER/ADMIN only. If the range has no data, an empty state explains how numbers arrive (Google Analytics, the extension, or "Log results"). |
| `/dashboard/memory` | "What works for you" (group `results`) | Any member of the active company | **Insight cards**, each showing the insight type, confidence, sample size and the `basis` behind it, with an "edited" mark if a user corrected it. OWNER/ADMIN can **edit** or **dismiss** an insight. **Analyze now**: OWNER/ADMIN only. **Engagement trend**, plus **Top performing** and **Lowest performing** lists (5 each). **Low-data states**: the "not enough data" note is shown as a warning banner. If there are no memories at all, an empty state names the gate ("at least 10 published posts … you have N"). In that state a manager gets **Analyze now** and anyone else gets **Log results from a post** (links to `/dashboard/analytics`). |

### User actions

| Action | UI component | Endpoint | Role |
|---|---|---|---|
| Run pattern extraction now | `components/dashboard/memory/analyze-button.tsx` | `POST /api/memory/generate` | `content:approve` (OWNER, ADMIN) |
| Correct an insight's wording | `components/dashboard/memory/insight-card.tsx` | `PATCH /api/memory/[id]` | `content:approve` |
| Dismiss an insight (with a confirm dialog) | `insight-card.tsx` | `DELETE /api/memory/[id]` | `content:approve` |
| Log results by hand for a published post, or at account level | `components/dashboard/analytics/log-result-dialog.tsx` | `POST /api/analytics/manual` | `content:approve` |
| Generate this week's written report | `components/dashboard/analytics/report-card.tsx` | `POST /api/analytics/report` | `content:approve` |
| Sync metrics from the user's own post page | Chrome extension | `POST /api/extension/metrics` | `content:create` (OWNER, ADMIN, MEMBER) |
| Mark an outreach message as connected or replied | Outreach UI | `POST /api/outreach/messages/[id]/outcome` | `content:approve` |

The manual dialog offers Impressions, Likes, Comments, Shares, Clicks and Followers (total). Every value must be a whole number, and at least one must be filled in. The draft picker lists up to 50 of the most recently published drafts. Untitled drafts are shown as "Untitled post".

## 3. How it works

### 3.1 Collecting performance data

Every source writes a `PerformanceSnapshot` with a `source` (`PerformanceSource`) and a free-form `metrics` JSON:

1. **Extension DOM** (`EXTENSION_DOM`). `recordContentMetrics()` in `performance.service.ts`:
   - First it tries an **exact** match: a `ContentDraft` with `status = PUBLISHED` and `publishedUrl = postUrl`.
   - If that fails it uses a **recent** fallback: the latest published draft from the last **14 days** that has no snapshots yet. That draft's `publishedUrl` is then overwritten with the synced permalink, so later syncs match exactly.
   - With no match at all, the snapshot is stored with `contentDraftId = null`, and the response reports `attach: 'none'`.
   - The `postUrl` is stored inside `metrics`. The action is audited as `PERFORMANCE_SNAPSHOT_CAPTURED`.
2. **Manual** (`MANUAL`). `POST /api/analytics/manual` writes the snapshot directly. If a `contentDraftId` is given, the route first checks that the draft belongs to the active company (otherwise 404). `capturedAt` is optional (ISO datetime, default now). Audited as `PERFORMANCE_LOGGED_MANUALLY`.
3. **Meta Graph** (`META_API`). Written by `server/connectors/meta-insights.service.ts`, which is owned by the Meta integration feature. Facebook shares are stored as `reposts`.
4. `LINKEDIN_API` exists in the enum, but no code path writes it. LinkedIn analytics are out of scope at the current OAuth scopes.

**Outreach outcomes** are not snapshots. `setOutreachOutcome()` sets `OutreachMessage.connectionAccepted` and `replyReceived` for a company-scoped message and audits `OUTREACH_OUTCOME_UPDATED`. A missing message throws a 404.

### 3.2 Engagement score (`server/memory/metrics.ts`)

```
engagementScore = likes + comments*3 + reposts*4 + clicks*2
```

`impressions` is accepted but carries no weight. `getContentPerformance()` also works out an approximate `wordCount` for each post from `renderForManual()` (`server/content/render.ts`), which the length analysis uses.

### 3.3 Marketing Memory extraction (`generateMemories`)

1. Load `perf = getContentPerformance(companyId)`. `sampleSize` is the number of published posts that have metrics.
2. **Deactivate all currently active memories** for the company (`isActive = false`). Each run replaces the previous generation.
3. If `sampleSize < MIN_SAMPLE_FOR_INSIGHTS` (**10**), store one `OTHER` / `LOW` note: "Not enough data yet — publish and sync metrics for at least 10 posts … (N so far.)". Its `supportingDataSummary` is `{ status: 'insufficient', have, need }`. The function audits and returns `{ status: 'insufficient' }`.
4. Otherwise compute `confidence` from sample size (`confidenceFromSample`): **HIGH ≥ 30**, **MEDIUM ≥ 15**, otherwise **LOW**. Every insight from the run gets this same confidence.
5. **Choose the extraction strategy.**
   - If `isClaudeConfigured()` is true (an Anthropic or Gemini key is set), call `completeStructured()` with `extractedInsightsSchema`, `tier: 'standard'`, `effort: 'medium'` and `maxTokens: 1200`. The prompt is a table of type, word count, weekday and engagement for each post. The system prompt asks for up to 5 data-grounded patterns, each with a one-line `basis`. The schema allows at most 8.
   - If the AI call throws, the service logs a warning and falls back to the deterministic analysis.
   - If no AI provider is configured, it uses the deterministic analysis straight away.
6. **Deterministic analysis** (`analyzeDeterministic`, pure and exported). It only emits an insight when the data shows a clear difference:
   - **CONTENT_FORMAT**: average engagement by content type, counting only types with at least 2 posts. Emitted when the best type's average is **more than 1.25×** the worst type's.
   - **CONTENT_LENGTH**: short posts (1–149 words) against long posts (150 words or more), with at least 2 in each group. Emitted when the gap is **more than 20%** of the larger average.
   - **TIMING**: average engagement by weekday, counting only days with at least 2 posts. Emitted when the best day's average is **more than 1.25×** the worst day's.
7. **Store the insights.** Each one becomes a `MarketingMemory` row with `supportingDataSummary = { basis, metric: 'engagement', sampleSize, model }`. Audit `MARKETING_MEMORY_GENERATED` with `{ status, sampleSize, created }`.

### 3.4 Correcting and dismissing (`server/memory/memory.service.ts`)

- **Correct.** `updateMemoryInsight()` trims and saves the new text and sets `supportingDataSummary.editedByUser = true`. It then calls `invalidateContextSnapshot(companyId)`, because `MarketingMemory` has no `updatedAt` and the Business Context snapshot cannot otherwise notice an in-place edit. New text must be 3–600 characters.
- **Dismiss.** `dismissMemory()` sets `isActive = false`. This is a soft delete: the row stays in the database for audit.
- Both functions look the row up with `{ id, companyId }` and throw "Insight not found." if it belongs to another workspace.
- Note that the next `generateMemories` run deactivates all active rows, including corrected ones, and writes a fresh generation.

### 3.5 Feeding memory back into generation

- **Business Context.** Active memories (up to 50) load as the `memory` section of the Business Context. They are mapped by `mapMemory()` in `server/business-context/build.ts`, which:
  - drops the "insufficient" note;
  - sorts user-edited insights first, then by confidence, then by sample size;
  - removes near-duplicate insights of the same type;
  - marks each insight `fresh`, `aging` or `stale` against `INSIGHT_MAX_AGE_DAYS = 60` (in `lib/business-context.ts`).

  `memoryBlock()` in `server/business-context/business-context.service.ts` then renders up to **12** non-stale insights under the heading "WHAT WE HAVE LEARNED WORKS FOR THIS ACCOUNT". Edited insights are tagged "confirmed by the company" and LOW-confidence ones "tentative — small sample". The workflows that load `memory` (`WORKFLOW_REQUIREMENTS`) are `content`, `planning`, `advisor`, `outreach`, `opportunity` and `recommendation`.
- **Campaign planner.** `server/campaigns/planner.ts` calls `getActiveMemories()` together with `memoriesToPrompt()`. That builds the same heading and list of lines, but without the freshness filter or the 12-insight cap.
- **Other readers** of active memories are the weekly briefing (`server/briefing/briefing.service.ts`, top 5), the advisor (`server/advisor/advisor.service.ts`, top 8), the Signals aggregator (`server/signals/signal.service.ts`, `MEMORY` source, top 50) and the Business Context snapshot (`server/business-context/snapshot.service.ts`).

### 3.6 Analytics aggregation (`getAnalytics(companyId, days = 30)`)

The window is `[now - days, now]`. Five queries run in parallel:

- `getContentPerformance()`, filtered to posts whose `publishedAt` falls in the window;
- `PUBLISHED` drafts in the window, for content volume per day;
- `SENT` outreach messages in the window, with their outcome flags;
- leads counted where `source = DISCOVERY_ENGINE`, by `createdAt` in the window;
- campaigns counted by `createdAt` in the window.

The result has these parts:

- `topline`: the seven counts listed in §2.
- `engagementTrend`: one point per published post, in date order.
- `contentVolume`: posts per UTC day.
- `funnel`: `{ sent, connected, replied }`.
- `channelBreakdown`: per content type, the post count and the rounded average engagement.
- `hasData`: true if posts, outreach, leads or measured posts are greater than zero.

Other places that call `getAnalytics` are Aura Home (`server/home/home.service.ts`, 14 days) and the WhatsApp read tools (`server/whatsapp/tools/read.ts`, 30 days).

### 3.7 Weekly written report (`generateAnalyticsReport`)

1. `weekStart = startOfIsoWeekUTC(now)` (imported from `server/competitors/report.service.ts`), and `weekEnd = weekStart + 7 days`.
2. Call `getAnalytics(companyId, 7)`. This is a rolling last-7-days window, not the ISO week itself.
3. **Write the summary.**
   - If `hasData` is false, it is a fixed sentence: "Not enough activity this week to report on yet…".
   - If no AI provider is configured, it is a sentence of facts plus a short line of advice.
   - Otherwise `complete()` is called with `tier: 'standard'`, `effort: 'low'` and `maxTokens: 500`, asking for 2–3 short paragraphs that use only the given numbers. If the call fails, the facts sentence is used instead.
4. **Upsert** on `(companyId, periodStart)`, which makes the report idempotent per ISO week. `metrics` stores the topline. Audited as `ANALYTICS_REPORT_GENERATED`.
5. The page shows `getLatestReport()`, the report with the newest `periodStart`.

### 3.8 Traceability export

`GET /api/analytics/traces?since=&limit=` returns `traceRows(companyId, …)` from `server/trace/trace.service.ts`. This is one flat row per approved or published asset, with its whole chain of IDs and its performance snapshots, for joining in an external analytics tool. `limit` is 1–500. The trace service itself belongs to the traceability feature.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | `app/dashboard/memory/page.tsx` | "What works for you": insights, trend chart, best and worst posts, honest empty and low-data states |
| Page | `app/dashboard/analytics/page.tsx` | "Results": range switch, stat cards, trend, funnel, content-type breakdown, report card, Log results |
| Component | `components/dashboard/memory/analyze-button.tsx` | Calls `POST /api/memory/generate`; shows a toast for the insufficient or ok result |
| Component | `components/dashboard/memory/insight-card.tsx` | Shows one insight with its confidence badge and basis; inline edit (PATCH) and dismiss (DELETE) |
| Component | `components/dashboard/memory/trend-chart.tsx` | Dependency-free inline-SVG line chart; needs at least 2 points (shared by both pages) |
| Component | `components/dashboard/analytics/bar-list.tsx` | CSS bar list for the funnel and the content-type breakdown |
| Component | `components/dashboard/analytics/log-result-dialog.tsx` | Manual results form that posts to `/api/analytics/manual` |
| Component | `components/dashboard/analytics/report-card.tsx` | Shows the latest report; "generate" button that posts to `/api/analytics/report` |
| API | `app/api/memory/generate/route.ts` | Runs extraction now (`maxDuration` 60) |
| API | `app/api/memory/[id]/route.ts` | PATCH corrects an insight, DELETE dismisses it (zod `patchSchema`) |
| API | `app/api/analytics/manual/route.ts` | Writes a manual `PerformanceSnapshot` (zod metrics and body schemas) |
| API | `app/api/analytics/report/route.ts` | Generates this week's report (`maxDuration` 60) |
| API | `app/api/analytics/traces/route.ts` | Flat traceability rows for measurement |
| API (cron) | `app/api/cron/memory/route.ts` | Runs extraction for every company; GET is aliased to POST |
| API (cron) | `app/api/cron/analytics/route.ts` | Runs the weekly report for every company; GET is aliased to POST |
| API (collector) | `app/api/extension/metrics/route.ts` | Receives the extension's DOM metric sync (Bearer extension auth) |
| API (collector) | `app/api/outreach/messages/[id]/outcome/route.ts` | Manual outreach outcome toggle |
| Service | `server/memory/extraction.service.ts` | `generateMemories`, `analyzeDeterministic`, AI extraction |
| Service | `server/memory/memory.service.ts` | `getActiveMemories`, `listMemories`, `isInsufficient`, `updateMemoryInsight`, `dismissMemory`, `memoriesToPrompt` |
| Service | `server/memory/performance.service.ts` | `recordContentMetrics`, `setOutreachOutcome`, `getContentPerformance`, `bestWorst`, `engagementTrend` |
| Lib (pure) | `server/memory/metrics.ts` | `engagementScore`, `MIN_SAMPLE_FOR_INSIGHTS`, `confidenceFromSample`, `hasEnoughData` |
| Service | `server/analytics/analytics.service.ts` | `getAnalytics` aggregation |
| Service | `server/analytics/report.service.ts` | `generateAnalyticsReport`, `getLatestReport` |
| Validation | `lib/validations/memory.ts` | `extensionMetricsSchema`, `outreachOutcomeSchema`, `extractedInsightsSchema` |
| Consumer | `server/business-context/build.ts` (`mapMemory`), `server/business-context/business-context.service.ts` (`memoryBlock`) | Turn memory into prompt context |
| Consumer | `server/campaigns/planner.ts` | Injects `memoriesToPrompt` into campaign planning |
| Test | `tests/marketing-memory.test.ts` | 10 tests: engagement weighting, confidence tiers, sample gate, `memoriesToPrompt`, `analyzeDeterministic` |

## 5. Data model

All three models are in `prisma/schema.prisma`, are scoped by `companyId`, and are deleted on cascade when the `Company` is deleted.

**`PerformanceSnapshot`**: one reading of real metrics.

| Field | Notes |
|---|---|
| `companyId` | Owning workspace |
| `contentDraftId?`, `outreachMessageId?`, `engagementCommentId?` | Optional subject. Only `contentDraftId` is written by this feature, and only it is read |
| `source` | `PerformanceSource`: `LINKEDIN_API`, `EXTENSION_DOM`, `MANUAL`, `META_API` |
| `metrics` | JSON. Keys used by the score are `likes`, `comments`, `reposts`, `clicks`. Also seen: `impressions`, `shares`, `followers`, `postUrl`, `platform`, `postId`, `detailed` |
| `capturedAt`, `createdAt` | Indexes on `[companyId, capturedAt]` and `[contentDraftId]` |

**`MarketingMemory`**: one learned insight.

| Field | Notes |
|---|---|
| `insightType` | `InsightType`: `CONTENT_FORMAT`, `CONTENT_LENGTH`, `TIMING`, `TOPIC`, `HASHTAG`, `OUTREACH_APPROACH`, `OTHER` |
| `insight` | Text |
| `confidence` | `MemoryConfidence`: `LOW` (default), `MEDIUM`, `HIGH` |
| `sampleSize` | Number of measured posts behind the run |
| `supportingDataSummary` | JSON: `{ basis, metric, sampleSize, model }`, plus `editedByUser` after a correction. The insufficient note has `{ status: 'insufficient', have, need }` |
| `isActive` | false once superseded or dismissed |
| `generatedAt`, `createdAt` | No `updatedAt`. Indexes on `[companyId, insightType]`, `[companyId, isActive]` and `[companyId, generatedAt]` |

**`AnalyticsReport`**: a stored weekly summary.

| Field | Notes |
|---|---|
| `periodStart`, `periodEnd` | `@@unique([companyId, periodStart])` |
| `summary` | Text |
| `metrics` | JSON copy of the topline |
| `generatedAt` | Refreshed on each regeneration |

**Also read:** `ContentDraft` (`status`, `publishedUrl`, `publishedAt`, `type`, `body`, `title`), `OutreachMessage` (`status`, `sentAt`, `connectionAccepted`, `replyReceived`), `Lead` (`source`, `createdAt`) and `Campaign` (`createdAt`).

**Audit actions written:** `PERFORMANCE_SNAPSHOT_CAPTURED`, `PERFORMANCE_LOGGED_MANUALLY`, `OUTREACH_OUTCOME_UPDATED`, `MARKETING_MEMORY_GENERATED`, `ANALYTICS_REPORT_GENERATED`.

## 6. API endpoints

See also [Internal API reference](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
|---|---|---|---|
| POST | `/api/memory/generate` | Run pattern extraction now. Returns `{ status, sampleSize, created }` | Session, active company, `content:approve` |
| PATCH | `/api/memory/[id]` | Correct an insight's text (3–600 characters). Returns `{ id, insight }` | Session, `content:approve`, company-scoped |
| DELETE | `/api/memory/[id]` | Dismiss an insight (soft delete). Returns `{ dismissed: true }` | Session, `content:approve`, company-scoped |
| POST | `/api/analytics/manual` | Log metrics by hand. Body is `{ contentDraftId?, capturedAt?, metrics }`. Returns 201 with `{ id }` | Session, `content:approve`, draft ownership checked |
| POST | `/api/analytics/report` | Generate or refresh this ISO week's report. Returns 201 with `{ id }` | Session, `content:approve` |
| GET | `/api/analytics/traces?since=ISO&limit=1..500` | Flat traceability rows | Session, active company (no extra permission) |
| POST | `/api/extension/metrics` | Extension DOM metric sync. Body is `{ postUrl, likes?, comments?, reposts?, impressions? }` with at least one metric | Extension Bearer token, `content:create` |
| POST | `/api/outreach/messages/[id]/outcome` | Set `connectionAccepted` and/or `replyReceived` | Session, `content:approve` |
| GET / POST | `/api/cron/memory` | Weekly extraction for all companies | `Authorization: Bearer $CRON_SECRET` |
| GET / POST | `/api/cron/analytics` | Weekly report for all companies | `Authorization: Bearer $CRON_SECRET` |

## 7. External services

| Service | Used for | Required env |
|---|---|---|
| Anthropic Claude or Google Gemini, via `server/ai/claude.ts` (see [AI Layer](../23-ai-layer/01-FEATURE-DETAILS.md)) | Insight extraction (`completeStructured`, `standard` tier) and the weekly report text (`complete`, `standard` tier) | `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY`. Both paths have a deterministic fallback when neither key is set |
| Meta Graph API | Indirect: the Meta insights collector writes `META_API` snapshots that this feature reads | See the Meta integration feature |

There is no server-side LinkedIn analytics fetch. See [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

| Route | Documented schedule (route comment) | Behaviour |
|---|---|---|
| `/api/cron/memory` | `0 10 * * 1` (Mondays 10:00 UTC) | Loops over all companies and runs `generateMemories` for each. One company failing is logged and does not stop the others. Returns `{ processed, ok, failed }` |
| `/api/cron/analytics` | `0 8 * * 1` (Mondays 08:00 UTC) | Same loop, running `generateAnalyticsReport` for each company |

Both routes reject requests (401) when `CRON_SECRET` is unset or the header does not match. Both have `maxDuration = 60` and export `GET = POST` so Vercel Cron can call them. **Neither is in `vercel.json`'s `crons`**, which only lists `publish`, `briefing` and `connections` because of the Hobby-plan limit (commit `36ebc5c`). They are listed in [VERCEL-DEPLOYMENT.md](../../../VERCEL-DEPLOYMENT.md), ready to paste back in. Until then, memory runs only through "Analyze now" and reports only through the report card button.

## 9. Security & permissions

- **Workspace scoping.** Every query filters by the active company's `companyId`:
  - `findFirst({ id, companyId })` before a memory update or dismiss;
  - a draft ownership check before a manual snapshot;
  - a company-scoped outreach message lookup.
- **RBAC** (`lib/rbac.ts`). The write actions (analyze, edit, dismiss, log results, generate report, outreach outcome) need `content:approve`, which only OWNER and ADMIN have. Extension metric sync needs `content:create`, so VIEWERs are refused with 403. Pages are visible to every member, and buttons are hidden without `content:approve`.
- **Validation** (zod):
  - Manual metrics are non-negative integers with caps: impressions ≤ 100,000,000; likes, comments, shares and clicks ≤ 10,000,000 each; followers ≤ 1,000,000,000. At least one is required.
  - Extension metrics are non-negative integers, at least one required, with a valid URL.
  - AI output is validated by `extractedInsightsSchema`: at most 8 insights, insight text ≤ 400 characters, basis ≤ 300 characters.
- **No fabrication.** The sample gate, the `hasData` flag and the honest empty states mean that neither a zero chart nor an invented insight is ever presented as real.
- **Cron routes** fail closed when `CRON_SECRET` is missing.

## 10. Testing

- `tests/marketing-memory.test.ts` (Vitest, 10 tests) covers `engagementScore` weighting, `confidenceFromSample` thresholds, `hasEnoughData`, `memoriesToPrompt` (empty, skips the insufficient note, formatting, type filter) and `analyzeDeterministic` (format insight, no insight on flat data, length insight).
- Indirect coverage:
  - `tests/context-snapshot.test.ts` and `tests/business-context-service.test.ts` cover memory as a Business Context source.
  - `tests/nav-clarity.test.ts` covers the "Results" and "What works for you" naming.
  - The `verify:signals`, `verify:context-handoff`, `verify:generation-context` and `verify:flow` scripts seed or read `MarketingMemory` as one input among many.
- There is no dedicated `pnpm verify:*` script and no unit test for `getAnalytics`, `generateAnalyticsReport` or the manual route.

## 11. Configuration & limits

| Setting | Value | Where |
|---|---|---|
| Minimum measured posts before any insight | 10 | `MIN_SAMPLE_FOR_INSIGHTS`, `server/memory/metrics.ts` |
| Confidence tiers | LOW < 15 ≤ MEDIUM < 30 ≤ HIGH | `confidenceFromSample` |
| Engagement weights | likes ×1, comments ×3, reposts ×4, clicks ×2 | `engagementScore` |
| Deterministic gaps | format and timing > 1.25×, length > 20%, at least 2 posts per bucket, short < 150 words | `analyzeDeterministic` |
| Recent-post fallback window for extension sync | 14 days | `recordContentMetrics` |
| Best / worst list size | 5 | `bestWorst(perf, n = 5)` |
| Analytics ranges | 7, 30 (default), 90 days | `app/dashboard/analytics/page.tsx` |
| Report window | Rolling 7 days; stored per ISO week | `generateAnalyticsReport` |
| Memory in prompts | Up to 12 insights, none older than 60 days (stale) | `memoryBlock`, `INSIGHT_MAX_AGE_DAYS` |
| AI budgets | Extraction 1,200 tokens (medium effort); report 500 tokens (low effort); both `standard` tier | services |
| Route timeouts | `maxDuration = 60` on generate, report and both cron routes | routes |
| Env | `CRON_SECRET`, `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` | see §7 |

## 12. Known limitations & future work

- **Manual "Shares" are not scored.** The manual form stores `shares`, but `engagementScore` reads `reposts`, so typed shares add nothing to engagement. `followers` and `impressions` are also unweighted.
- **Weekly crons are not scheduled on Vercel** (see §8). Memory and reports only refresh when someone clicks the button.
- **Regeneration replaces corrections.** `generateMemories` deactivates every active row, including ones marked `editedByUser`, before writing new ones. This contradicts the "never silently overwrite" intent in `memory.service.ts` comments.
- **The `model` label can be wrong.** `supportingDataSummary.model` records `DEFAULT_MODEL` whenever any AI provider is configured. The call actually uses the `standard` tier, which can be Gemini, so the label may not name the model that ran.
- **Only content is analysed.** The AI prompt and the deterministic analysis look only at content performance. Outreach outcomes appear in the Analytics funnel but are not mined for `OUTREACH_APPROACH` insights, and `TOPIC` and `HASHTAG` can only come from the AI path.
- **Snapshots with `contentDraftId = null`** (unmatched extension syncs, account-level manual entries) are stored but ignored by every aggregate.
- The report's `periodStart` is the ISO week start, but its numbers cover the trailing 7 days from generation time.
- `LINKEDIN_API` snapshots are never written, so LinkedIn post metrics depend on the extension or manual entry.

## 13. Related documents

- [SPRINT-5-TECHNICAL.md](../../../SPRINT-5-TECHNICAL.md): original Marketing Memory design
- [SPRINT-6-TECHNICAL.md](../../../SPRINT-6-TECHNICAL.md): original Analytics design
- [PRODUCT-DOCUMENTATION.md](../../../PRODUCT-DOCUMENTATION.md)
- [BUSINESS-CONTEXT-MODEL.md](../../../BUSINESS-CONTEXT-MODEL.md): how memory enters the Business Context
- [SIGNAL-AGGREGATION.md](../../../SIGNAL-AGGREGATION.md): memory as a signal source
- [TRACEABILITY.md](../../../TRACEABILITY.md): the trace rows behind `/api/analytics/traces`
- [VERCEL-DEPLOYMENT.md](../../../VERCEL-DEPLOYMENT.md): cron entries to restore
- [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md)
- Sibling features: [AI Layer](../23-ai-layer/01-FEATURE-DETAILS.md), [Aura Home & Briefing](../10-aura-home-and-briefing/01-FEATURE-DETAILS.md), [Campaigns & Content Planner](../14-campaigns-and-content-planner/01-FEATURE-DETAILS.md), [Recommendations & Aura Suggests](../09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md)
- [Architecture](./02-ARCHITECTURE.md)
