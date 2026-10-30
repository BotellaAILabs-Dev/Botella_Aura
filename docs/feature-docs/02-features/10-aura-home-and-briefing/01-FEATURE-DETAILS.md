# Aura Home, What Matters Now & Weekly Briefing

> Aura Home (`/dashboard`) is the first page a signed-in user sees. It is built around recommendations, not metrics, and answers three questions in order: *what matters right now*, *what does Aura suggest*, and *what happened recently*. Two scheduled products feed it. The **weekly briefing** ("This week") is built by the Autopilot cycle: it writes and illustrates the week's posts, then puts together a Monday summary. **AI Marketing Intelligence** (`/dashboard/intelligence`) is a daily marketing-health score with ranked suggestions for improvement. All three follow one rule: show only what Aura actually recorded, and when there is too little data, say so and say what is missing.

## 1. Overview

The feature has three parts. They share a page but have separate code paths:

| Part | What it is | Where it is computed |
| --- | --- | --- |
| **Aura Home** | Live sections: What matters now, Waiting on you, Aura Suggests, Active opportunities, Results, Recent activity | `server/home/home.service.ts` (loading) + `lib/aura-home.ts` (pure rules) |
| **What matters now** | The business situation: high-relevance active opportunities plus important signal changes that no opportunity covers, with a state (`ready`, `limited`, `quiet`, `insufficient`) and a list of data gaps | `server/home/what-matters.service.ts` + `lib/what-matters.ts` |
| **Weekly briefing + Autopilot** | A weekly cycle per workspace. It writes posts from the marketing plan (or from the trend digest when there is no plan), generates one graphic per post within the image allowance, can schedule or auto-approve depending on the workspace setting, and stores a `WorkspaceBriefing` snapshot | `server/briefing/autopilot.service.ts` + `server/briefing/briefing.service.ts` |
| **AI Marketing Intelligence** | A daily snapshot of deterministic scores (setup foundations, performance, content, brand), a weighted overall score, and suggestions ranked by impact. A model may reword the suggestions | `server/intelligence/*` |

Home loads the briefing (`getLatestBriefing`) and the live home data (`getAuraHome`) in parallel. The briefing is shown under "This week". Everything above it is computed live on every request (`export const dynamic = 'force-dynamic'`).

## 2. User-facing behaviour

### Aura Home — `/dashboard` (`app/dashboard/page.tsx`)

Any member of the active workspace can open it. Sections, top to bottom:

1. **Header**: "Good to see you, <first name>" plus a shortcut to Content Studio. If the user has no active workspace, the page shows "Welcome" and "Create a workspace to get started." instead.
2. **Setup checklist** (`SetupChecklist`): shown until `getOnboardingState(...).finished`. It is full-size before the first briefing exists and `compact` after.
3. **What matters now** (`WhatMattersNow`): the summary sentence, up to 5 items, data gaps with actions, a "Based on N current signals…" line, and the **Waiting on you** strip. The strip lists, in this order: posts to approve, suggestions you said yes to (with their next step), approved posts to schedule, new leads to review, and outreach ready to send.
4. **Aura Suggests**: the top 3 suggestions (`AuraSuggests` with `surface="home"`, `compact`), plus "See all (n)" linking to `/dashboard/suggestions`. With no suggestions, the section shows one of two things. If `readiness.canRecommend` is false, it shows a `ReadinessPanel` that says what Aura needs. Otherwise it shows an empty line that mentions accepted suggestions still waiting for a next step and links to `/dashboard/opportunities`.
5. **Active opportunities** (`ActiveOpportunities`): up to 4. Opportunities closing within 7 days come first, then the rest by priority score, then by detection date.
6. **Results** (`ResultsSummary`): tiles for Posts published, Engagement, Marketing health (only if an `IntelligenceSnapshot` exists) and Suggestions acted on. Each tile is compared with the previous period.
7. **This week**: `BriefingView` if a briefing exists, otherwise `GettingStarted`. Both have a run button ("catch me up") that calls `POST /api/briefing` with `{ force: true }`.
8. **Recent activity** (`RecentActivity`): up to 8 lines from the last 14 days.
9. **Everything else**: links to Content Studio, Content plan, Market trends, Competitors, Marketing health, Campaign ideas, Leads and Results.

Role gating on Home:

- `canDecide` = `can(role, 'company:update')` (OWNER, ADMIN). It is passed to `AuraSuggests` as `canAct` and to `ReadinessPanel`.
- `canRun` = `can(role, 'content:create')` (OWNER, ADMIN, MEMBER). It enables recording suggestion actions and the briefing run button. VIEWER sees everything read-only.

### AI Marketing Intelligence — `/dashboard/intelligence` (`app/dashboard/intelligence/page.tsx`)

Titled "AI Marketing Intelligence" and linked from Home as "Marketing health". It shows the latest snapshot (`getLatestIntelligence`), a score history covering 60 days (`getScoreHistory(active.id, 60)`), the setup foundation steps, score blocks, the weakest content pieces and ranked suggestions (`IntelligenceView`, `score-parts.tsx`). Users with `content:create` can recompute the snapshot. The recompute runs as a background `INTELLIGENCE` generation job through `useGenerationJob`. When no snapshot exists, the page starts one run automatically, at most once per browser tab (`sessionStorage` key `aura.intelligence.autostarted`).

## 3. How it works

### 3.1 Aura Home loading (`getAuraHome`)

`getAuraHome(companyId, now)` runs seven loaders in parallel. Each is wrapped in `part(name, companyId, fallback, load)`: if a loader throws, the error is logged as `home: <name> unavailable`, that loader returns its fallback, and the rest of Home still renders.

| Part | Source | Window / cap |
| --- | --- | --- |
| suggestions | `getSuggestions(companyId, { now })` | Home shows the first 3; `suggestionCount` is the total |
| counts | `contentDraft` PENDING_APPROVAL; APPROVED with `scheduledFor` and `publishedAt` both null; `lead` NEW; `outreachMessage` APPROVED | live |
| opportunities | `listOpportunitiesForView(companyId, { now, limit: 100 })` → `toOpportunityView` → `statusGroup === 'active'` | `activeOpportunities(list, 4)` |
| results | `getAnalytics(companyId, 14)`, the last 2 `intelligenceSnapshot` rows, and recommendations decided in the last 30 days | 14 / 30 days |
| activity | `recommendationEvent` (excluding `present` and `withdraw`, take 30), opportunities (10), drafts created (10), drafts published (10), competitor snapshots with `changesSummary.hasChanges = true` (5), READY briefings (2) | 14 days, `buildActivity(..., limit 8)` |
| what matters | `getWhatMatters` | see 3.2 |
| readiness | `getReadiness` | see feature 09 |

Rules in `lib/aura-home.ts`:

- **`waitingOnYou`** builds the to-do strip from the counts and the accepted suggestions. Items with a count of zero are left out.
- **`activeOpportunities`** sorts by: closing within 7 days first, then `priorityScore` descending, then `detectedAt` descending, then `id`. It returns the first 4. `closesIn` labels the deadline: "Closes today", "Closes tomorrow" or "Closes in N days" when the deadline is 30 days or less away, and nothing beyond that.
- **`splitWeeks`** sums dated points into this week (age under 7 days) and last week (7–14 days).
- **`buildResults`** compares each value with the period before:
  - Equal values with a previous value of 0 give no change. Equal non-zero values give "Same as last week".
  - Growth from 0 gives "Up from none last week". Otherwise the change is shown as a rounded percentage.
  - Engagement shows "—" unless analytics `hasData` is true and the two weeks together are above zero.
  - Health shows the change in points since the previous snapshot.
  - Suggestions acted on is shown as "X of Y" for the last 30 days. Recommendations count as answered if their status is ACCEPTED, EDITED, SKIPPED, REJECTED, IN_PROGRESS or COMPLETED, and as acted on if it is ACCEPTED, EDITED, IN_PROGRESS or COMPLETED.
- **`buildActivity`** puts items newest first and drops anything dated in the future.
  - It folds routine work: when 3 or more items share a `group` (`suggested`, `spotted`, `wrote`, `published`) and an actor, and fall within one day (`GROUP_WINDOW = DAY`), they become one line such as "made N new suggestions".
  - It removes duplicate lines (same actor and text) and keeps the first 8.
  - Only Aura's own actions carry a group: generate events without an actor, opportunities, drafts with no `createdById`, and publishes.
  - `recommendationActivity` turns event actions into text: link, generate, accept, edit, skip, reject, start, complete, defer and expire.

### 3.2 What matters now (`buildWhatMatters`)

`getWhatMatters` loads:

- up to 100 opportunities, keeping those in `ACTIVE_STATUSES` (DETECTED, REVIEWED, RECOMMENDED), each with its newest live recommendation;
- up to 300 current signals (`expiresAt` null or in the future), with the active opportunity each one is linked to and any live recommendation that cites it as evidence;
- the coverage inputs: `CompanyTrendConfig.keywords` plus the business-context market keywords, the `CompetitorProfile` count, the `AnalyticsReport` count, whether business-context goals are set, and the latest `lastSeenAt` among the signals.

Limits (`WHAT_MATTERS_LIMITS`): `items: 5`, `opportunities: 3`, `changeDays: 14`, `relevantScore: 60`.

- **High-relevance opportunity** (`isHighRelevance`): priority HIGH or URGENT, *or* `priorityScore >= 60`, *or* `daysLeft <= 7`. These are sorted with non-LOW confidence first, then by soonest closing, then by score, and the top 3 are kept. The urgency label appears only when the opportunity closes within 14 days.
- **Important change** (`isImportantChange`): the signal has not expired and was observed within the last 14 days, and its source qualifies:
  - COMPETITORS: any change except `metadata.change === 'positioning'`.
  - ANALYTICS: only when `metadata.from` and `metadata.to` are both numbers.
  - TRENDS: only when reliability is not LOW, *or* `occurrences > 1`, *or* the signal has a context match.
  - All other sources are never treated as a change.
  - Signals already covered by a chosen opportunity are excluded. The remaining changes are sorted by reliability, then absolute strength, then recency, and they fill the list up to 5 items in total.
- **Why it matters** (`whyChangeMatters`) is built only from the signal's own summary and metadata: the direction of the analytics change, the type of competitor change (pricing, homepage, release, other), and the matched trend keyword or occurrence count.
- **Confidence labels**: HIGH gives "Strong evidence", MEDIUM gives "Good evidence", LOW gives "Early sign — limited evidence" (marked weak). Strong items are listed before weak ones.
- **Related link**: an open recommendation (GENERATED or PRESENTED) gives "See Aura's suggestion". An accepted one (ACCEPTED, EDITED, IN_PROGRESS) gives "You said yes — see the next step". An opportunity with no recommendation gives "Ask Aura for a suggestion".
- **Gaps** (each with an action link): no trend keywords; no competitors tracked; fewer than 2 result periods; no goals set.
- **State**:
  - `insufficient` when there are no current signals and no open opportunities, or when there are no items and 3 or more gaps.
  - `quiet` when there are no items and fewer than 3 gaps.
  - `limited` when every item is weak, or when there are 3 or more gaps.
  - `ready` otherwise.
  - The summary sentence is written only from the items.

### 3.3 Weekly cycle: Autopilot then briefing

`runAutopilot({ companyId, userId, force })`:

1. Reads the settings from `Company.preferences.autopilot` (`readAutopilotSettings`):
   - `enabled` is true unless it is explicitly `false`.
   - `postsPerWeek` defaults to 3 (`DEFAULT_WEEKLY_POSTS`) and is clamped to 0–5 (`MAX_WEEKLY_POSTS`).
   - `generateGraphics` is true unless it is explicitly `false`.
   - `publishMode` is one of `review`, `schedule` or `auto`. Any unrecognised value is treated as `review`.
2. If Autopilot is disabled, it still assembles the briefing and returns `ran: false`.
3. If `force` is not set and this ISO week's briefing already exists with a status other than FAILED, it re-assembles the briefing only and returns "Already ran for this week." This makes the cycle idempotent per week, so a retried cron does not write posts or pay for graphics twice.
4. Upserts the week's row to `WORKING`, then calls `writeWeeklyContent`:
   - It writes nothing when `postsPerWeek` is 0 or when `isClaudeConfigured()` is false. Each case records a line in `activity.skipped`.
   - It collects briefs (`collectBriefs`) from `MarketingPlan` items dated this week first, using brief, hook and CTA. If the plan has too few, it falls back to items from the latest `TrendDigest`, written as `LINKEDIN_POST`. With neither source it writes nothing and says so.
   - It sets an image budget once (`resolveImageBudget`): zero if no image provider is configured or the subscription is inactive, otherwise `min(wanted, maxImagesPerMonth − assetsThisMonth)`. A shortfall is explained in `skipped`.
   - For each brief it calls `generateDraft` (source `BRIEF`), then `illustrate` for one image (`variations: 1`, style `professional`). A failed image does not discard the post.
   - In `schedule` or `auto` mode it calls `recommendSlot` for each post. A post is APPROVED only when `canPublishAutomatically` allows it (mode `auto` **and** at least one `linkedInConnection` exists) and the weekly cap of `MAX_AUTO_PUBLISH_PER_WEEK = 5` has not been reached. Every other post stays a DRAFT with a scheduled time. Auto-approvals write an approval trace (`withApprovalTrace`, `withApprovedContentVersion`), call `syncCampaignTask`, and record a `CONTENT_APPROVED` audit entry with `by: 'autopilot'`.
5. Calls `generateBriefing(status: 'READY')` and records an `AUTOPILOT_RUN` audit entry. Errors for individual posts go into `activity.errors` (each entry up to 300 characters). A whole-run failure is logged and the briefing is still assembled.

`generateBriefing` / `assembleBriefing` make **no model calls**: they read only data that already exists.

- `weekStart = startOfIsoWeekUTC(now)` (Monday 00:00 UTC) and `weekEnd = weekStart + 7 days − 1 ms`.
- Inputs:
  - drafts updated this week or still in DRAFT, PENDING_APPROVAL or APPROVED (take 40);
  - the latest `TrendDigest`, `CompetitorReport`, `AdvisorReport` and `IntelligenceSnapshot`;
  - up to 5 active `MarketingMemory` rows;
  - the latest `MarketingPlan`;
  - the attention counts.
- Sections:
  - `calendar`: drafts dated this week, followed by plan items not yet written. A draft replaces the plan item with the same title. Capped at 30.
  - `readyContent`: drafts in DRAFT, PENDING_APPROVAL or APPROVED, capped at 12.
  - `competitorMoves`: from the competitor report, using new launches, then pricing changes, then notable activity. Up to 15 competitors.
  - `recommendations`, up to 10:
    - "Approve N posts" (high priority) when posts are pending approval;
    - up to 3 advisor opportunities (medium);
    - up to 2 marketing memories whose confidence is not LOW (low).
  - `insights`, up to 8: Marketing health (the score and its basis), Published this week, and Posts with a graphic.
  - `attention`: the non-zero counts.
  - `headline` and `summary`: template sentences.
  - `coverage`: `used` lists the sections that had data. `skipped` gives a reason for each empty section (calendar, competitors, insights).
- The result is upserted on `(companyId, weekStart)`. A refresh resets `readAt` to null so the briefing shows as unread again. Audit entries: `BRIEFING_GENERATED`, or `BRIEFING_FAILED` when the row is stored as FAILED with an error of up to 1000 characters.

The payload and activity are validated and read safely through `lib/validations/briefing.ts` (`readBriefingPayload`, `readBriefingActivity`). Field caps include: headline 300, summary 1500, calendar 30, readyContent 30, competitorMoves 15, recommendations 10, insights 8, attention 10.

`toBriefingView` adds two flags: `isCurrentWeek` (the row's `weekStart` equals this week's) and `read` (`readAt` is set). Home shows the **latest** briefing for any week, so on a Monday before the cron has run, users see last week's briefing labelled as such rather than an empty section.

### 3.4 AI Marketing Intelligence (`generateIntelligenceSnapshot`)

1. Loads the latest 40 drafts (`DRAFT_SAMPLE`), all `PerformanceSnapshot` rows linked to a draft, and `analysePerformance(companyId)`. That function scores the 30-day window (`WINDOW_DAYS`) for campaigns, leads, competitor visibility, content output and outreach, and includes `analyseFoundations`.
2. Scores the content with deterministic text metrics (`text-metrics.ts`: `readability`, `hookStrength`, `ctaEffectiveness`, `structure`, `predictEngagement`) and scores brand consistency against the brand voice profile (`analyseBrand`).
3. **Foundations** are always measurable. Their steps and weights: website 10, industry 5, brand voice 20, knowledge base 15, 3 competitors tracked 20 (`COMPETITOR_TARGET = 3`), lead requirement 15, first content 10, a data source connected 5.
4. **Overall score** (`computeOverall`): a weighted mean over the blocks that have data. Weights: foundations 3, contentQuality 3, contentOutput 2, leadGeneration 2, outreach 2, brandConsistency 2, measuredPerformance 2, campaign 1, competitorVisibility 1. Blocks with no data are excluded, not counted as zero, and the basis text names what was included. If only foundations have data, `scoreKind = 'setup'` and the basis says this is setup progress, not marketing health.
5. **Suggestions** (`ruleBasedSuggestions`):
   - Impact = `(weight / totalWeight) × gap to 80` (`TARGET_SCORE`). An unmeasured block counts with its full gap.
   - Priority: high if impact is 6 or more, medium if 2.5 or more, low otherwise.
   - The weakest draft gets a rewrite suggestion if its quality score is below 55.
   - Suggestions are sorted by impact and capped at 10. During the setup stage, setup suggestions are listed first.
6. If `isClaudeConfigured()`, a `completeStructured` call (`effort: 'high'`, `maxTokens: 2500`) rewords and reorders the suggestions, returning at most 8 against a Zod schema. Impact and priority are still computed by the code, matched by area. If the call fails, the rule-based suggestions are kept and `model` stays `'none'`.
7. Upserts `IntelligenceSnapshot` on `(companyId, date = start of UTC day)` and records an `INTELLIGENCE_SNAPSHOT_GENERATED` audit entry.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/page.tsx` | Aura Home; loads briefing, membership, onboarding state and `getAuraHome` in parallel; role gating |
| Page | `app/dashboard/intelligence/page.tsx` | AI Marketing Intelligence page; latest snapshot plus 60-day history |
| Component | `components/dashboard/home/home-sections.tsx` | `HomeSection`, `WhatMattersNow`, `ActiveOpportunities`, `ResultsSummary`, `RecentActivity` |
| Component | `components/dashboard/briefing/briefing-view.tsx` | Renders the briefing payload and activity; "run now" (`POST /api/briefing`, `force: true`) |
| Component | `components/dashboard/briefing/getting-started.tsx` | Shown before the first briefing exists; same run action |
| Component | `components/dashboard/intelligence/intelligence-view.tsx` | Intelligence dashboard; `INTELLIGENCE` job via `useGenerationJob`; auto-start once per tab |
| Component | `components/dashboard/intelligence/score-parts.tsx` | Score block presentation pieces |
| API | `app/api/briefing/route.ts` | GET latest, POST run cycle, PATCH mark read |
| API | `app/api/intelligence/route.ts` | GET latest snapshot, POST recompute synchronously |
| API (cron) | `app/api/cron/briefing/route.ts` | Weekly Autopilot for every company |
| API (cron) | `app/api/cron/intelligence/route.ts` | Daily intelligence snapshot for every company |
| Service | `server/home/home.service.ts` | `getAuraHome`; loaders isolated per part |
| Service | `server/home/what-matters.service.ts` | `getWhatMatters`; loads opportunities, signals, coverage |
| Service | `server/briefing/autopilot.service.ts` | `runAutopilot`, `readAutopilotSettings`, `canPublishAutomatically`, `PUBLISH_MODES`, `MAX_AUTO_PUBLISH_PER_WEEK` |
| Service | `server/briefing/briefing.service.ts` | `assembleBriefing`, `generateBriefing`, `getLatestBriefing`, `getCurrentBriefing`, `markBriefingRead`, `toBriefingView` |
| Service | `server/intelligence/intelligence.service.ts` | `generateIntelligenceSnapshot`, `getLatestIntelligence`, `getScoreHistory` |
| Service | `server/intelligence/performance-intelligence.ts` | `analysePerformance` (30-day ratios) |
| Service | `server/intelligence/foundations.ts` | `analyseFoundations` (setup steps and weights) |
| Service | `server/intelligence/content-intelligence.ts` | `prepareDrafts`, `analyseContent` |
| Service | `server/intelligence/brand-intelligence.ts` | `analyseBrand` (tone probes, hype words, vocabulary) |
| Lib | `server/intelligence/text-metrics.ts` | Pure readability, hook, CTA, structure and engagement metrics |
| Lib | `server/intelligence/types.ts` | `IntelligencePayload`, `ScoreBlock`, `ImprovementSuggestion`, … |
| Lib | `lib/aura-home.ts` | Pure Home rules: `waitingOnYou`, `activeOpportunities`, `closesIn`, `buildResults`, `splitWeeks`, `buildActivity`, `recommendationActivity`, `relativeTime` |
| Lib | `lib/what-matters.ts` | Pure: `buildWhatMatters`, `isHighRelevance`, `isImportantChange`, `whyChangeMatters`, `WHAT_MATTERS_LIMITS` |
| Lib | `lib/validations/briefing.ts` | Zod schemas and tolerant readers for briefing payload and activity |
| Job runner | `server/jobs/runners.ts` (`INTELLIGENCE`) | Background job that calls `generateIntelligenceSnapshot` |
| Legacy | `server/services/dashboard.service.ts` | `getDashboardSnapshot` (action items, trend peek, totals) from the older Overview; nothing references it any more |
| Tests | `tests/aura-home.test.ts`, `tests/what-matters.test.ts`, `tests/briefing.test.ts`, `tests/intelligence-priority.test.ts`, `tests/text-metrics.test.ts` | Unit tests |
| Scripts | `scripts/verify-home.ts`, `scripts/verify-what-matters.ts`, `scripts/verify-briefing.ts` | End-to-end checks against a real database |

## 5. Data model

| Model / enum | Owned? | Key fields | Notes |
| --- | --- | --- | --- |
| `WorkspaceBriefing` | Owned | `id`, `companyId`, `weekStart` (Monday 00:00 UTC), `weekEnd`, `status: BriefingStatus`, `payload Json`, `activity Json`, `error Text?`, `model` (default `"none"`), `generatedAt`, `readAt?` | Unique `(companyId, weekStart)`; idempotency key for the weekly cycle |
| `BriefingStatus` enum | Owned | `WORKING`, `READY`, `FAILED` | |
| `IntelligenceSnapshot` | Owned | `id`, `companyId`, `date` (start of UTC day), `payload Json`, `overallScore Int` (default 0), `model` (default `"none"`), `generatedAt` | Unique `(companyId, date)`; index `(companyId, date)`; cascade on company delete |
| `Company.preferences.autopilot` | Used (JSON) | `enabled`, `postsPerWeek`, `generateGraphics`, `publishMode` | No migration; edited via `PATCH /api/company/autopilot` (settings feature) |
| `ContentDraft` | Used | `status`, `scheduledFor`, `publishedAt`, `createdById`, `media`, `aiMetadata` | Counts, calendar, activity; Autopilot creates, schedules and may approve drafts |
| `Opportunity`, `OpportunitySignal`, `Signal`, `RecommendationEvidence` | Used | status, priority, `priorityScore`, `expiresAt`, `reliability`, `occurrences`, `strength`, `contextMatches`, `metadata` | What matters now |
| `Recommendation`, `RecommendationEvent` | Used | `status`, `decidedAt`, event `action`, `actorId`, `metadata.module` | Results tile and activity |
| `Lead`, `OutreachMessage` | Used | `status` NEW / APPROVED | Waiting on you and briefing attention |
| `TrendDigest`, `CompetitorReport`, `CompetitorSnapshot`, `CompetitorProfile`, `AdvisorReport`, `MarketingMemory`, `MarketingPlan`, `AnalyticsReport`, `CompanyTrendConfig`, `PerformanceSnapshot`, `LinkedInConnection` | Used | — | Inputs to briefing, Autopilot, coverage and intelligence |

## 6. API endpoints

See also [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| GET | `/api/briefing` | Latest briefing (`BriefingView` or `null`) | Member of the active company |
| POST | `/api/briefing` | Run the weekly cycle now (`{ force?: boolean }`); returns `ran`, `reason`, `activity`, `briefing`. `maxDuration = 60` | `content:create`; rate limit of 2 per hour per company (`briefing-run:<companyId>`), 429 when exceeded |
| PATCH | `/api/briefing` | Mark a briefing read (`{ briefingId }`, 400 if missing) | Member; the update is scoped by `companyId` |
| GET | `/api/intelligence` | Latest snapshot, without recomputing | Member |
| POST | `/api/intelligence` | Recompute today's snapshot synchronously; returns score, drafts analysed, suggestion count, model | `content:create` |
| GET/POST | `/api/cron/briefing` | Weekly Autopilot for every company, run in sequence | `Authorization: Bearer $CRON_SECRET`; refused if the secret is unset |
| GET/POST | `/api/cron/intelligence` | Daily snapshot for every company | `Authorization: Bearer $CRON_SECRET`; refused if the secret is unset |
| POST | `/api/jobs` (kind `INTELLIGENCE`) | Queue an intelligence run from the UI (jobs feature) | `content:create` |

Aura Home itself has no API route: it is a Server Component that calls the services directly.

## 7. External services

- **Anthropic / Gemini** through `server/ai/claude.ts`. The briefing has no model calls. Autopilot writes posts through `generateDraft` (content generation) and image prompts. Intelligence makes one `completeStructured` call to reword suggestions. All of these are skipped when `isClaudeConfigured()` is false (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`).
- **Image providers** through `server/media/providers` (`isAnyProviderConfigured`), used for the one Autopilot graphic per post.
- The billing plan limit `maxImagesPerMonth` (`getEffectivePlan`) caps graphics.

Environment variables: [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

| Job | Trigger | Schedule | Behaviour |
| --- | --- | --- | --- |
| `/api/cron/briefing` | Vercel Cron (`vercel.json`) | `0 5 * * 1` (Mondays 05:00 UTC) | `runAutopilot` per company, in sequence; failures are logged and the company is skipped; returns processed, ran, skipped, failed, draftsWritten, graphicsGenerated; `maxDuration = 60` |
| `/api/cron/intelligence` | Any scheduler with `CRON_SECRET` | Documented as daily (`0 5 * * *`) in the route comment, but **not present in `vercel.json`** | `generateIntelligenceSnapshot` per company, in sequence; idempotent per day |
| `INTELLIGENCE` generation job | UI, via `/api/jobs` | On demand | Reports progress ("Scoring your content, leads and brand…" at 25, "Writing recommendations…" at 85) |

Both cron handlers export `GET = POST`, because Vercel Cron calls with GET.

## 9. Security & permissions

- All pages and routes resolve the **active company** (`resolveActiveCompany` / `requireActiveCompany`), and every query filters on `companyId`. `markBriefingRead` uses `updateMany({ id, companyId, readAt: null })`, so another workspace's briefing cannot be marked.
- `POST /api/briefing` and `POST /api/intelligence` require `content:create`, which VIEWER does not have. Manual briefing runs are rate limited to 2 per hour per company, because each run can write posts and generate images (spend).
- Auto-publishing is opt-in (`publishMode: 'auto'`), requires a connected channel, is capped at 5 per week, and any unknown value falls back to `review`. Changing the Autopilot settings requires `content:approve` (`app/api/company/autopilot/route.ts`).
- Cron routes refuse requests when `CRON_SECRET` is unset and require a matching bearer token.
- Audit entries: `BRIEFING_GENERATED`, `BRIEFING_FAILED`, `AUTOPILOT_RUN`, `CONTENT_APPROVED` (by autopilot), `INTELLIGENCE_SNAPSHOT_GENERATED`.

## 10. Testing

| Test | Covers |
| --- | --- |
| `tests/aura-home.test.ts` | Waiting on you, opportunity ordering, results comparisons, activity folding and wording |
| `tests/what-matters.test.ts` | Relevance, change detection, states, gaps, no fabrication |
| `tests/briefing.test.ts` | Autopilot settings defaults, clamping, tolerant parsing; briefing payload and activity contracts |
| `tests/intelligence-priority.test.ts` | Impact-based improvement priority |
| `tests/text-metrics.test.ts` | Deterministic text metrics |
| `pnpm verify:home` | Real workspace end to end, including a simulated source outage |
| `pnpm verify:what-matters` | Real workspace through brand new, profile only, real activity and decision made |
| `pnpm verify:briefing` | Real Autopilot and briefing assembly: degrades without API keys, idempotent per week |

## 11. Configuration & limits

| Setting | Value | Where |
| --- | --- | --- |
| Suggestions on Home | 3 | `home.service.ts` |
| Active opportunities on Home | 4; "closing soon" = within 7 days | `activeOpportunities` |
| Recent activity | 14 days, 8 lines, groups of 3 or more within 1 day are folded | `loadActivity`, `buildActivity` |
| Results windows | posts and engagement: this vs last 7 days (from 14 days of analytics); suggestions: 30 days | `loadResults` |
| What matters now | 5 items, 3 opportunities, 14-day changes, score threshold 60 | `WHAT_MATTERS_LIMITS` |
| Signals considered | 300 newest current | `what-matters.service.ts` |
| Autopilot posts per week | default 3, max 5 | `DEFAULT_WEEKLY_POSTS`, `MAX_WEEKLY_POSTS` |
| Auto-publish cap | 5 per week | `MAX_AUTO_PUBLISH_PER_WEEK` |
| Graphics | 1 per post, within the plan's monthly allowance | `resolveImageBudget`, `illustrate` |
| Manual briefing runs | 2 per hour per company | `POST /api/briefing` |
| Intelligence draft sample | 40 | `DRAFT_SAMPLE` |
| Intelligence target score / priority cut-offs | 80; high ≥ 6, medium ≥ 2.5 | `TARGET_SCORE`, `priorityFor` |
| Env | `CRON_SECRET`, `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, image provider keys | see section 7 |

## 12. Known limitations & future work

- The `/api/cron/intelligence` route exists but is not scheduled in `vercel.json`. Without a scheduler, snapshots only appear when a user runs the analysis, which leaves the health tile's "since the last check" comparison sparse.
- The briefing rate limit (`lib/rate-limit.ts`) is kept in memory, per server instance, so it is not shared across serverless instances.
- `canPublishAutomatically` checks only for a `LinkedInConnection` when deciding whether a channel is connected.
- Autopilot's trend-digest fallback always writes `LINKEDIN_POST`.
- `PATCH /api/briefing` (mark read) is implemented, but the current Home components never call it, so `read` / `readAt` is not set from the UI.
- `server/services/dashboard.service.ts` (`getDashboardSnapshot`) is left over from the old Overview and is not referenced anywhere.
- Briefing insights carry `delta: null`. They are not compared with the previous week, unlike the live Results tiles.

## 13. Related documents

- [../../../AURA-HOME.md](../../../AURA-HOME.md)
- [../../../WHAT-MATTERS-NOW.md](../../../WHAT-MATTERS-NOW.md)
- [../../../AURA-SUGGESTS.md](../../../AURA-SUGGESTS.md)
- [../../../EMPTY-STATES.md](../../../EMPTY-STATES.md)
- [../../../SCHEDULER.md](../../../SCHEDULER.md)
- [../../../VERCEL-DEPLOYMENT.md](../../../VERCEL-DEPLOYMENT.md)
- [../../../CLIENT-REVIEW-STATUS.md](../../../CLIENT-REVIEW-STATUS.md)
- [../../../PRODUCT-DOCUMENTATION.md](../../../PRODUCT-DOCUMENTATION.md)
- Sibling features: [../09-recommendations-and-aura-suggests/](../09-recommendations-and-aura-suggests/), [../14-campaigns-and-content-planner/](../14-campaigns-and-content-planner/), [../18-marketing-memory-and-analytics/](../18-marketing-memory-and-analytics/), [../23-ai-layer/](../23-ai-layer/)
- Architecture: [02-ARCHITECTURE.md](02-ARCHITECTURE.md)
