# Trend Insights

> Trend Insights (shown in the app as **Market trends**) builds a daily digest of what a company's market is talking about. It pulls items from Hacker News, Reddit, news RSS feeds and, if configured, X / Twitter. It scores and ranks them, then asks Claude to explain why each one matters to the business and to suggest a post angle. On top of that it adds a summary of the week's themes, recommendations, hashtags, upcoming seasonal moments and mentions of tracked competitors. The feature exists so a marketing team gets timely, relevant topics to post about without reading the internet every morning. Every item is also checked for brand safety, so a tragedy never comes back as a "post idea".

## 1. Overview

- **What it produces:** one `TrendDigest` row per company per UTC day. The row holds a JSON `DigestPayload` with up to 20 ranked items (`TOP_N = 20` in `server/trends/digest.service.ts`) plus a digest-level synthesis.
- **Where the user sees it:** `/dashboard/trends` (page title "Market trends"; nav label "Market trends" in `lib/nav.ts`). It is configured at `/dashboard/settings/trends` ("Trend sources").
- **How it runs:**
  - **Scheduled:** `GET|POST /api/cron/trends` loops over every company.
  - **On demand:** the dashboard's **Refresh** / **Generate first digest** button queues a `TREND_DIGEST` background job through the generic jobs API.
  - **Legacy:** a synchronous `POST /api/trends/refresh` route also exists.
- **Design rules that appear in the code:**
  - **"NON-NEGOTIABLE #5":** never fabricate data for a source that isn't configured. Such a source is skipped and listed in `skippedSources`.
  - **"NON-NEGOTIABLE #6":** generation is idempotent per company/day. It upserts on `(companyId, date)`.
- **Graceful degradation:** without `ANTHROPIC_API_KEY`, the digest still ships with deterministic summaries, angles and hashtags, and `payload.model` is `"fallback"`.
- **Downstream consumers:** digests are read by Signals (`server/signals/normalize.ts`, `source: 'TRENDS'`), the Advisor, the marketing planner, the weekly briefing / autopilot, the dashboard service and Content Studio (`?trendId=` hand-off). See [Signals & Opportunities](../08-signals-and-opportunities/).

## 2. User-facing behaviour

| Screen | Route | What the user can do | Who |
|---|---|---|---|
| Market trends | `/dashboard/trends` | View the latest digest, or pick one from the last 7 days (`?date=YYYY-MM-DD`). Read the synthesis cards and the trend cards. Refresh today's digest. Open "Configure sources". | Any signed-in member of the active company can view it. Starting a refresh job needs `content:create` (OWNER, ADMIN, MEMBER). |
| Trend sources | `/dashboard/settings/trends` | Edit keywords, subreddits, competitors to watch, extra RSS feeds, country, language, region, city, time range, and per-source toggles. Then **Save trend sources**. | Any member (the API checks membership only; see §9). |
| Settings hub | `/dashboard/settings` | A "Trend sources" card links to the config page. | Any member |

### Market trends page (`app/dashboard/trends/page.tsx`)

- **First run (no digests in the last 7 days):** an empty state reads "No digest yet" and offers a **Generate first digest** button. The copy says it usually takes about a minute.
- **Header:** shows "Generated `<time>` · AI: `<model>`", or "basic summaries" when `model === 'fallback'`. It also holds the history dropdown (`DigestHistory`, hidden when there is 1 or fewer entries), "Configure sources", and **Refresh**.
- **Source transparency banner:** when `payload.skippedSources` is non-empty, a banner lists the sources that "aren't connected yet" and links to trend settings.
- **`TrendSummary` cards:**
  - "This week's read": the summary, numbered "Recommended this week" items, and "Trending hashtags".
  - "Upcoming moments": seasonal events, each with an "in Nd" or "today" badge.
  - "Competitor mentions": up to 6 are shown.
- **`TrendCard` grid** (each card shows):
  - a source badge, relative age and `score`;
  - the title, linked through `safeExternalUrl`;
  - the AI "why this matters" note and the "Suggested angle";
  - a brand-safety badge: **Not for promotion** (destructive) or **Handle with care** (warning), with the reason;
  - a CTA to `/dashboard/content/new?trendId=<id>`. The CTA reads "Generate content from this", or a muted "Write about this anyway" when the item is unsuitable.
- **Empty digest:** when a digest has 0 items, the page shows "No trends matched today" with an "Adjust keywords" link.
- **Footer:** "Insights refresh automatically once a day … it replaces today's, never duplicates it."

### Refresh (`components/dashboard/trends/refresh-button.tsx`)

- Uses `useGenerationJob('TREND_DIGEST')`, which works in four steps:
  1. `POST /api/jobs` creates the job.
  2. A fire-and-forget `POST /api/jobs/:id/run` executes it.
  3. The client polls `GET /api/jobs/:id` every 1.5 s, for at most 400 polls (about 10 minutes).
  4. Progress messages from the digest are shown in `JobProgressBar`.
- On mount the button calls `attach()`, which reattaches to a digest job already running for the company.
- On success it shows a toast ("Digest updated — N trends." or "Digest refreshed. No new trends matched your settings yet.") and calls `router.refresh()`.

### Trend sources form (`components/dashboard/trends/trend-config-form.tsx`)

- The form validates on the client with the same `updateTrendConfigSchema` the API uses, then sends `PUT /api/trends/config`.
- **Country options:** Global, US, GB, IN, CA, AU, DE, FR, ES, BR, AE, SG.
- **Languages:** en, es, fr, de, pt, hi.
- **Time ranges:** 1, 7 or 30 days.
- **Source notes:**
  - Hacker News: "No key needed".
  - Google News (RSS): "No key needed".
  - Reddit: "No key needed (public RSS)".
  - X / Twitter: "Optional — needs bearer token".

## 3. How it works

`generateDigestForCompany({ companyId, userId?, trigger, onProgress? })` in `server/trends/digest.service.ts` runs these steps:

1. **Load config (progress 8%).** Load the `Company`, then call `ensureTrendConfig` and `seedSmartDefaults(company)`. Seeding is best-effort and its errors are logged, not thrown. Next, `toFetchContext(config, company)` adds `company.industry`, and `getEnabledFlags(config)` reads the source toggles.
2. **Pick sources.**
   - `getEnabledSources(flags)` returns every source unless its flag is `false`. Twitter is the exception: it runs only when its flag is explicitly `true`.
   - A source whose `isConfigured(ctx)` is false goes into `skippedSources`.

   | Source | `isConfigured` rule |
   |---|---|
   | `hackernews` | always `true` |
   | `reddit` | at least 1 subreddit |
   | `news` | at least 1 keyword, or at least 1 RSS feed |
   | `twitter` | `TWITTER_BEARER_TOKEN` set and at least 1 keyword |
3. **Fetch in parallel (20%).** `Promise.allSettled` over the runnable sources. A rejected source is counted as `0` in `sourceCounts` and logged. It never fails the digest.
4. **Score and rank (55%).** `scoreAndRank(all, ctx, { limit: 20 })` in `server/trends/scoring.ts`:
   - **`dedupe`:** removes duplicates by `id` and by normalised title, so the same story from two sources appears once.
   - **`scoreItem`:** score = `0.35·recency + 0.30·engagement + 0.35·relevance`, scaled to 0–100 with one decimal. The breakdown is kept in `scoreBreakdown`.
     - *Recency:* `0.5^(ageHours / 24)`, which is a 24-hour half-life.
     - *Engagement:* `log1p(points + 2·comments) / log1p(500)`, capped at 1. A source with no metrics (news RSS, Reddit RSS) scores 0.
     - *Relevance:* `min(1, matchedKeywords / 3)`. Add `+0.25` if the title or summary contains a competitor name, and `+0.1` if a matched keyword is in the title. The result is capped at 1.
   - **Order:** score descending; ties go to the newer item.
5. **Business context.** `getBusinessContext(companyId, { sections: [] })` feeds two fields:
   - `brand.about`, from `businessContextToPrompt(..., { identity: true })`;
   - `brand.voice`, from `voice.summary`, defaulting to `'professional, practical, no hype'`.

   See [Business Context](../05-business-context/).
6. **Enrich items (`enrichItems`).**
   - **Brand-safety check first.** Every item is classified *before* any model call with `classifySource(title + summary)` from `lib/brand-safety.ts`. The posture is `clear`, `caution` or `unsuitable`, and `concerns` is filled from `TOPIC_LABEL`.
   - **No Claude, or a Claude error:** use `fallbackSummary` ("Relevant on `<source>` to `<company>`." plus the points, if any) and `fallbackAngle`. The fallback angle is posture-aware: unsuitable items get "Not something to post about commercially…".
   - **With Claude:** one `completeStructured` call for the whole batch, validated against `enrichmentSchema`:
     - fields: `id` ≤80, `aiSummary` ≤600, `suggestedAngle` ≤600, `suitableForPromotion`, `notSuitableReason` ≤300; at most 60 items;
     - call settings: `maxTokens: 3000`, `effort: 'medium'`, `tier: 'standard'`.
   - **How the prompt carries safety:** each non-clear item carries its own `!! BRAND SAFETY:` line from `anglePolicyFor`.
   - **Combining verdicts:** the deterministic and model verdicts are combined by taking the stricter. If only the model objects, a `clear` posture becomes `caution`. On an unsuitable item the model's `suggestedAngle` is discarded.
7. **Synthesise (80%, `synthesizeDigest`).** One more `completeStructured` call over the first 12 items:
   - output: `summary` ≤1500, `recommendations` up to 6 (each ≤300), `hashtags` up to 12 (each ≤60);
   - call settings: `maxTokens: 1024`.
   - Items marked "NOT FOR PROMOTION" may inform the summary but must not become recommendations or hashtags.
   - As a safety net, `namesExcluded` drops any recommendation that shares at least `min(4, titleWords)` words longer than 4 letters with an excluded headline.
   - At most 4 recommendations are kept.
   - **Fallback:** a templated summary, the top 3 postable titles as recommendations, and `deriveFallbackHashtags`: the 6 most frequent title words of 4 or more letters, minus a stop-word list, CamelCased.
   - **Zero items:** returns "No trends crossed the relevance bar today…".
8. **Seasonal moments.** `upcomingSeasonalEvents(new Date(), [...keywords, industry])` in `server/trends/seasonal.ts`:
   - reads a curated, first-party calendar of 23 dated events;
   - returns events within **45 days**, at most **4**;
   - an untagged event is always relevant; a tagged event needs a substring match against the keywords or industry.
9. **Competitor mentions.** `findCompetitorMentions(items, config.competitorNames)` does a case-insensitive substring match of each name (at least 2 characters) against item **titles**.
10. **Persist (95%).** `db.trendDigest.upsert` on `companyId_date`, where `date` is the start of the current UTC day. Then record an `AuditLog` row `TREND_DIGEST_GENERATED` with `{ trigger, itemCount, model, sourceCounts }`.

### Source connectors (`server/trends/sources/`)

| Source | File | Endpoint(s) | Limits / rules |
|---|---|---|---|
| Hacker News | `hackernews.ts` | Firebase API `https://hacker-news.firebaseio.com/v0/topstories.json` + `/item/{id}.json` | Scans the top **120** stories in batches of **12**. Keeps titles matching a keyword and returns `[]` when there are no keywords. Timeouts are 8 s (index) and 6 s (items). |
| Reddit | `reddit.ts` | With `REDDIT_CLIENT_ID`/`SECRET`: app-only OAuth, then `oauth.reddit.com/r/{sub}/hot?limit=25`. Without keys: public `reddit.com/r/{sub}/hot/.rss?limit=25` (Atom). | At most **8** subreddits. The OAuth token is cached at module level and refreshed 30 s before expiry. If keywords exist, a post must match one. With no keywords, all hot posts are kept. RSS exposes no engagement. |
| News | `rss.ts` | Per keyword: Google News RSS search (with `when:{days}d`) and Bing News RSS. Google News topic headlines `BUSINESS` + `NATION` in the workspace locale. Industry feeds (up to 4, regex-matched on industry + keywords). Curated marketing feeds (Marketing Dive, Entrepreneur). The company's own RSS feeds. | **10** keywords, **8** custom feeds, **20** items per feed. Freshness window is `timeRangeDays`, or **4** days when unset. `cache: 'no-store'`. Curated, topic and industry feeds require a keyword match when keywords exist. Undated items are kept. The locale defaults to `US` / `en`. |
| X / Twitter | `twitter.ts` | `api.twitter.com/2/tweets/search/recent` | One combined query per digest: the first **5** keywords, `-is:retweet lang:en`, `max_results=25`. Points = likes + retweets, comments = replies. |

### Smart defaults (`server/services/trend-config.service.ts`)

- **When it runs:** `seedSmartDefaults` runs once per company, only while `defaultsSeeded` is false. It is triggered by the settings page and at the start of every digest.
- **With Claude:**
  - calls `completeJson` with the company name, the industry and `businessContextToPrompt(context, 'qualification')`;
  - asks for 8–12 keywords, 4–8 subreddits and 0–5 competitors.
- **Without Claude, or if Claude fails:** a heuristic.
  - keywords: industry, name, `marketing`, `AI`;
  - subreddits: `marketing`, `smallbusiness`, `Entrepreneur`, `SaaS`;
  - competitors: none.
- **Stored caps:** 15 keywords, 10 subreddits, 10 competitors.
- **Audit:** records `AI_SUGGESTION_GENERATED` with `{ kind: 'trend_defaults', source }`.
- **User edits:** any save through `updateTrendConfig` sets `defaultsSeeded = true`, so defaults never overwrite a user's choices.

### Reading stored digests

- `normalizeDigestPayload(raw)` turns any stored payload into a renderable `DigestPayload`.
  - Missing arrays become `[]`, a missing `model` becomes `'fallback'`, and a missing `generatedAt` becomes the epoch.
  - It is used by the page, Signals, the Advisor and the planner, so digests from older builds degrade instead of crashing.
- `getRecentDigests(companyId, days = 7)` feeds the page history.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | [`app/dashboard/trends/page.tsx`](../../../../app/dashboard/trends/page.tsx) | Server component: loads 7 days of digests, picks one by `?date`, renders the summary and cards |
| Page | [`app/dashboard/settings/trends/page.tsx`](../../../../app/dashboard/settings/trends/page.tsx) | Seeds smart defaults on first visit, renders `TrendConfigForm` |
| Component | [`components/dashboard/trends/trend-card.tsx`](../../../../components/dashboard/trends/trend-card.tsx) | One digest item: source badge, score, safety badge/reason, AI note, angle, Content Studio CTA |
| Component | [`components/dashboard/trends/trend-summary.tsx`](../../../../components/dashboard/trends/trend-summary.tsx) | Summary, recommendations, hashtags, seasonal moments, competitor mentions |
| Component | [`components/dashboard/trends/refresh-button.tsx`](../../../../components/dashboard/trends/refresh-button.tsx) | Starts or reattaches to a `TREND_DIGEST` job, shows progress |
| Component | [`components/dashboard/trends/digest-history.tsx`](../../../../components/dashboard/trends/digest-history.tsx) | 7-day history `<select>` that navigates to `?date=` |
| Component | [`components/dashboard/trends/trend-config-form.tsx`](../../../../components/dashboard/trends/trend-config-form.tsx) | Config form (keywords, subreddits, competitors, feeds, geo, time range, source toggles) |
| API | [`app/api/trends/config/route.ts`](../../../../app/api/trends/config/route.ts) | `GET` / `PUT` trend config for the active company |
| API | [`app/api/trends/refresh/route.ts`](../../../../app/api/trends/refresh/route.ts) | Synchronous manual digest generation (`maxDuration = 60`) |
| API (cron) | [`app/api/cron/trends/route.ts`](../../../../app/api/cron/trends/route.ts) | Scheduled run over all companies, one at a time; `Bearer CRON_SECRET` |
| API (jobs, shared) | [`app/api/jobs/route.ts`](../../../../app/api/jobs/route.ts), [`app/api/jobs/[id]/run/route.ts`](../../../../app/api/jobs/%5Bid%5D/run/route.ts) | Queue and run the `TREND_DIGEST` job used by the Refresh button |
| Job runner | [`server/jobs/runners.ts`](../../../../server/jobs/runners.ts) | `TREND_DIGEST` runner: calls `generateDigestForCompany` with `onProgress`, returns `{ digestId, itemCount, model, skippedSources }` |
| Service | [`server/trends/digest.service.ts`](../../../../server/trends/digest.service.ts) | Orchestrator, AI enrichment, synthesis, competitor mentions, fallbacks, `normalizeDigestPayload`, `getRecentDigests` |
| Service | [`server/services/trend-config.service.ts`](../../../../server/services/trend-config.service.ts) | `ensureTrendConfig`, `toFetchContext`, `getEnabledFlags`, `updateTrendConfig`, `seedSmartDefaults` |
| Lib (pure) | [`server/trends/scoring.ts`](../../../../server/trends/scoring.ts) | `SCORING` constants, `scoreItem`, `dedupe`, `scoreAndRank` |
| Lib (pure) | [`server/trends/seasonal.ts`](../../../../server/trends/seasonal.ts) | Curated calendar + `upcomingSeasonalEvents` |
| Types | [`server/trends/types.ts`](../../../../server/trends/types.ts) | `TrendSource`, `TrendItem`, `TrendFetchContext`, `ScoredTrendItem`, `DigestItem`, `DigestPayload`, `SeasonalEvent`, `CompetitorMention` |
| Sources | [`server/trends/sources/index.ts`](../../../../server/trends/sources/index.ts) | `ALL_SOURCES` registry + `getEnabledSources` |
| Sources | [`server/trends/sources/hackernews.ts`](../../../../server/trends/sources/hackernews.ts), [`reddit.ts`](../../../../server/trends/sources/reddit.ts), [`rss.ts`](../../../../server/trends/sources/rss.ts), [`twitter.ts`](../../../../server/trends/sources/twitter.ts) | Connectors (see §3) |
| Validation | [`lib/validations/trends.ts`](../../../../lib/validations/trends.ts) | `updateTrendConfigSchema`, `enabledSourcesSchema` |
| Lib (shared) | [`lib/brand-safety.ts`](../../../../lib/brand-safety.ts) | `classifySource`, `anglePolicyFor`, `TOPIC_LABEL`, used before enrichment |
| Lib (shared) | [`server/ai/claude.ts`](../../../../server/ai/claude.ts) | `completeStructured`, `completeJson`, `isClaudeConfigured`, `getModel` |
| Tests | [`tests/scoring.test.ts`](../../../../tests/scoring.test.ts), [`tests/hackernews-source.test.ts`](../../../../tests/hackernews-source.test.ts), [`tests/trend-sources.test.ts`](../../../../tests/trend-sources.test.ts), [`tests/digest-payload.test.ts`](../../../../tests/digest-payload.test.ts) | See §10 |

## 5. Data model

Defined in [`prisma/schema.prisma`](../../../../prisma/schema.prisma).

### `CompanyTrendConfig` (1:1 with `Company`, owned)

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | `cuid()` | PK |
| `companyId` | String | — | `@unique`; FK to `Company`, cascade delete |
| `keywords` | String[] | `[]` | Topics to match |
| `subreddits` | String[] | `[]` | Names without `r/` |
| `rssFeeds` | String[] | `[]` | Extra feed URLs |
| `competitorNames` | String[] | `[]` | Light watch list. `CompetitorProfile` is the system of record (see [Competitor Intelligence](../07-competitor-intelligence/)) |
| `enabledSources` | Json | `{"reddit":true,"hackernews":true,"news":true,"twitter":false}` | Read through `getEnabledFlags` |
| `geoCountry` | String? | null | ISO-2; null means global (news falls back to `US`) |
| `geoRegion`, `geoCity` | String? | null | Appended to news queries as location hints |
| `language` | String | `"en"` | News locale |
| `timeRangeDays` | Int | `4` | News freshness window |
| `defaultsSeeded` | Boolean | `false` | Stops smart defaults overwriting edits |
| `createdAt` / `updatedAt` | DateTime | | |

### `TrendDigest` (owned)

| Field | Type | Notes |
|---|---|---|
| `id` | String | PK (`cuid`) |
| `companyId` | String | FK to `Company`, cascade delete |
| `date` | DateTime | Start of the UTC day |
| `payload` | Json | `DigestPayload` (default `{}`) |
| `createdAt` | DateTime | |

Constraints: `@@unique([companyId, date])` (idempotency), `@@index([companyId])`, `@@index([companyId, date])`.

**`payload` (`DigestPayload`)** has these fields:

- `items: DigestItem[]`, where each item has `id`, `title`, `url`, `source`, `sourceLabel`, `score`, `publishedAt`, `aiSummary`, `suggestedAngle` and an optional `safety { posture, concerns[], suitableForPromotion, reason }`.
- `generatedAt`, `model`, `sourceCounts`, `skippedSources`.
- Optional `summary`, `recommendations[]`, `hashtags[]`, `seasonal[]` (`{ date, name, daysUntil, angle }`) and `competitorMentions[]` (`{ competitor, itemId, title, url, sourceLabel }`).

### Used, not owned

- `GenerationJob` with `kind = TREND_DIGEST`. `status` runs `QUEUED → RUNNING → SUCCEEDED | FAILED`; `progress`, `result` and `error` carry the run's state. A digest job counts as stuck after the default **10 minutes** of inactivity (`STUCK_AFTER_MS`).
- `AuditLog` actions: `TREND_CONFIG_UPDATED`, `TREND_DIGEST_REQUESTED`, `TREND_DIGEST_GENERATED`, `AI_SUGGESTION_GENERATED`.
- `Company` (`name`, `industry`).

## 6. API endpoints

Full reference: [Internal API](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| GET | `/api/trends/config` | Return the active company's config (`keywords`, `subreddits`, `rssFeeds`, `competitorNames`, `enabledSources`, `geoCountry`, `geoRegion`, `geoCity`, `language`, `timeRangeDays`, `defaultsSeeded`). Creates the row if missing. | `requireUser` + active company + membership (any role). 400 when there is no active company, 403 when the user is not a member. |
| PUT | `/api/trends/config` | Validate with `updateTrendConfigSchema` and upsert. Returns the list fields + `enabledSources`. Audits `TREND_CONFIG_UPDATED`. | Same as GET (no RBAC permission check) |
| POST | `/api/trends/refresh` | Generate today's digest synchronously. Audits `TREND_DIGEST_REQUESTED` and returns `{ id, date, itemCount, model, skippedSources }`. A non-HTTP error returns **502** with a readable message. `maxDuration = 60`. | Same as GET (no RBAC permission check) |
| GET, POST | `/api/cron/trends` | Generate digests for every company, one at a time. Returns `{ processed, ok, failed }`. `GET` is an alias, because Vercel Cron uses GET. `maxDuration = 60`. | `Authorization: Bearer $CRON_SECRET`. Fails closed (401) when the secret is unset. |
| POST | `/api/jobs` (`kind: "TREND_DIGEST"`) | Queue a digest job. If one is already in flight, it is reused (200 instead of 201). | `requireActiveCompany` + `content:create` |
| POST | `/api/jobs/:id/run` | Claim and run the job (`maxDuration = 60`) | `requireActiveCompany` + `content:create` |
| GET | `/api/jobs/:id`, `/api/jobs?kind=TREND_DIGEST` | Poll or reattach to a job | `requireActiveCompany` |

## 7. External services

See [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md).

| Service | Used for | Env vars | Required? |
|---|---|---|---|
| Anthropic Claude (`server/ai/claude.ts`) | Item enrichment, digest synthesis, smart defaults | `ANTHROPIC_API_KEY` (model from `getModel()`) | No. Without it, deterministic fallbacks are used and `model = "fallback"` |
| Hacker News Firebase API | Top stories | — | No key |
| Reddit | Subreddit hot posts | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (optional upgrade to OAuth), `REDDIT_USER_AGENT` (default `botella-aura/0.1 (trend intelligence)`) | No. Falls back to public RSS |
| Google News RSS, Bing News RSS, publisher RSS feeds | News items | — | No key |
| X / Twitter API v2 recent search | Tweets | `TWITTER_BEARER_TOKEN` | Optional; also needs the `twitter` source toggle on |
| Cron scheduler | Daily run | `CRON_SECRET` | Needed for `/api/cron/trends` |

## 8. Background jobs & cron

- **`/api/cron/trends`:** loops over `db.company.findMany()` one company at a time ("gentle on third-party rate limits shared across tenants"). Each company's digest is committed as it finishes, so a 60 s timeout part-way through loses no completed work. The route comment suggests the schedule `0 13 * * *`, **but the route is not in the current `vercel.json` `crons`**, which only lists `publish`, `briefing` and `connections`. It must be scheduled externally, or added there.
- **`TREND_DIGEST` generation job:** queued via `/api/jobs`, run by `/api/jobs/:id/run` → `server/jobs/runners.ts`, and reported through `onProgress` at 8 / 20 / 55 / 80 / 95 %. Retry, orphan pickup and stuck detection come from `server/jobs/job.service.ts`, which allows up to 3 attempts.

## 9. Security & permissions

- **Workspace scoping:**
  - Every route resolves the active company from the session (`resolveActiveCompany` / `requireActiveCompany`) and checks membership. A digest is always generated and read by `companyId`.
  - `findTrendItem` in Content Studio reads only the company's own last 7 digests.
- **RBAC:**
  - The jobs path (the one the UI uses) requires `content:create`, so VIEWER is denied.
  - `/api/trends/config` (GET/PUT) and `/api/trends/refresh` only check membership, so a VIEWER can change trend config or trigger a synchronous refresh through these routes.
- **Validation (`lib/validations/trends.ts`):**
  - **Keywords:** up to 25; strings 1–80 characters, trimmed and de-duplicated.
  - **Subreddits:** up to 15; `r/` is stripped and names must match `^[A-Za-z0-9_]{2,50}$`.
  - **RSS feeds:** up to 10 valid URLs.
  - **Competitor names:** up to 25.
  - **`enabledSources`:** all four booleans are required.
  - **`geoCountry`:** at most 2 characters, upper-cased; empty means null.
  - **`geoRegion` / `geoCity`:** at most 80 characters; empty means null.
  - **`language`:** 2–5 characters, default `en`.
  - **`timeRangeDays`:** an integer from 1 to 90, default 4.
- **Cron auth:** a plain string equality check of the `authorization` header against `Bearer ${CRON_SECRET}`. The route fails closed when the secret is unset.
- **Output safety:**
  - External links render through `safeExternalUrl`.
  - Brand-safety classification gates the angles and recommendations (§3.6–3.7).
  - The fallback paths respect the same posture.
- **No fabrication:** an unconfigured source is skipped and shown to the user. A failing source contributes 0 items, never placeholder items.
- **Audit:** config updates, refresh requests, generated digests and seeded defaults are all written to `AuditLog`.

## 10. Testing

| File | Covers |
|---|---|
| `tests/scoring.test.ts` | `scoreItem` range/breakdown, recency, engagement, keyword and competitor boosts; `dedupe`; `scoreAndRank` ordering and limit |
| `tests/hackernews-source.test.ts` | Always configured, keyword filtering, `TrendItem` normalisation, empty-keywords behaviour |
| `tests/trend-sources.test.ts` | News locale (`resolveGeo`, `googleTopicUrl`), industry-feed matching (`industryFeeds`), curated feeds are marketing-only and https |
| `tests/digest-payload.test.ts` | `normalizeDigestPayload` on old, null and malformed payloads |
| `tests/brand-safety.test.ts` | The brand-safety classifier the digest relies on |

Run them with `pnpm test` (vitest). There is no dedicated `pnpm verify:*` script for trends. Several verify scripts seed `TrendDigest` rows as input for downstream features, for example `verify:signals`, `verify:detection` and `verify:home`.

## 11. Configuration & limits

| Setting | Value | Where |
|---|---|---|
| Items per digest | 20 (`TOP_N`); `scoreAndRank` defaults to 8 when no limit is given | `digest.service.ts`, `scoring.ts` |
| Scoring weights | recency 0.35 / engagement 0.30 / relevance 0.35 | `SCORING` |
| Recency half-life | 24 h | `SCORING.recencyHalfLifeHours` |
| Engagement saturation | 500 (points + 2×comments) | `SCORING.engagementSaturation` |
| HN scan | 120 stories, concurrency 12 | `hackernews.ts` |
| Reddit | 8 subreddits, 25 posts each | `reddit.ts` |
| News | 10 keywords, 8 custom feeds, 20 items/feed, 4-day default window, at most 4 industry feeds | `rss.ts` |
| Twitter | 5 keywords, 25 results, 1 request/digest | `twitter.ts` |
| Seasonal | within 45 days, at most 4 events | `seasonal.ts` |
| Synthesis | first 12 items in; at most 4 recommendations kept | `digest.service.ts` |
| Smart defaults caps | 15 keywords / 10 subreddits / 10 competitors | `trend-config.service.ts` |
| History window | 7 days (page and Content Studio lookup) | `page.tsx`, `server/content/generator.ts` |
| Route budget | `maxDuration = 60` on refresh, cron and job run | routes |
| Default source flags | reddit, hackernews, news on; twitter off | `DEFAULT_ENABLED` |

## 12. Known limitations & future work

- **Cron not scheduled:** `/api/cron/trends` is not registered in `vercel.json`, so "refresh automatically once a day" depends on an external scheduler.
- **Sequential cron:** the cron runs all companies one after another inside one 60 s function. `BACKLOG.md` item I1 tracks moving this to a durable queue or worker.
- **Weak RBAC on two routes:** `/api/trends/config` and `/api/trends/refresh` check membership only, not `content:create` or `company:update`.
- **Legacy refresh route:** the UI no longer calls `/api/trends/refresh`, because it uses the jobs API. The route remains as a synchronous alternative.
- **Time-range mismatch:** the default `timeRangeDays` is 4, but the settings form only offers 1, 7 and 30, so a fresh config has no matching option in the select.
- **Feed cap mismatch:** validation accepts up to 10 RSS feeds, but the news source reads only the first 8.
- **Shallow competitor matching:** competitor mentions match item titles only, by substring. Relevance scoring also checks summaries.
- **Missing engagement:** news and Reddit RSS items carry no engagement, so they score 0 on that 30 % component.
- **Fixed seasonal calendar:** it has fixed month/day dates (for example Black Friday on 28 Nov every year) and is not localised.
- **Unused helpers:** `describeSourceReadiness`, `getLatestDigest` and `getTrendConfig` are exported but not called anywhere.
- **Stale schema comment:** the comment on `TrendDigest` in `schema.prisma` describes `sources: {...counts}`, but the payload field is `sourceCounts`.

## 13. Related documents

- [Sprint 2 technical documentation](../../../SPRINT-2-TECHNICAL.md): original design of the trend pipeline
- [Product documentation §7.3 Trend Intelligence](../../../PRODUCT-DOCUMENTATION.md)
- [Signal aggregation](../../../SIGNAL-AGGREGATION.md): how digest items become `TRENDS` signals
- [Vercel deployment](../../../VERCEL-DEPLOYMENT.md): cron configuration
- [Business Context model](../../../BUSINESS-CONTEXT-MODEL.md)
- Sibling features: [05 Business Context](../05-business-context/), [07 Competitor Intelligence](../07-competitor-intelligence/), [08 Signals & Opportunities](../08-signals-and-opportunities/)
- [Architecture](./02-ARCHITECTURE.md)
