# Signals & Opportunity Detection

> Aura collects observations from every part of the product (market trends, competitor changes, analytics movements, learned "what works" patterns and the business's own context) and turns them into one store of **signals**. Detection reads that store and records **opportunities**: things the business could act on, each with the evidence behind it, a derived confidence and priority, a relevance window and a tracked lifecycle. Three detectors write opportunities: deterministic rules, AI-assisted detection that is validated against the signals it cites, and the AI Marketing Advisor ("Campaign ideas"). The feature exists so that every later suggestion Aura makes can be traced to a real observation instead of a guess.

## 1. Overview

The feature has three layers.

| Layer | What it does | Main code |
| --- | --- | --- |
| **Signal aggregation** | Reads 5 sources, normalises each observation to one shape (`NormalizedSignal`), de-duplicates by `dedupeKey`, rates reliability, associates it with the Business Context, and stores it as a `Signal` row | `lib/signals.ts`, `server/signals/normalize.ts`, `server/signals/signal.service.ts` |
| **Opportunity detection** | 5 deterministic rules plus shared gates (`lib/opportunity-detection.ts`); AI-assisted detection for 3 categories the rules cannot judge (`lib/ai-opportunity-detection.ts`); the advisor's campaign opportunities (`server/advisor/advisor.service.ts`) | `server/opportunities/detection.service.ts`, `server/opportunities/ai-detection.service.ts`, `server/opportunities/from-advisor.ts` |
| **Opportunity store and lifecycle** | `recordOpportunity` (idempotent by `dedupeKey`), derived confidence/priority, status transitions with compare-and-swap, expiry, history, mirroring decisions onto open recommendations | `lib/opportunities.ts`, `server/opportunities/opportunity.service.ts` |

Opportunities feed the recommendation engine (see [../09-recommendations-and-aura-suggests](../09-recommendations-and-aura-suggests/)): every recommendation points at one opportunity via `Recommendation.opportunityId`.

## 2. User-facing behaviour

### Opportunities page: `/dashboard/opportunities`

Server page `app/dashboard/opportunities/page.tsx` loads every opportunity with `listOpportunitiesForView` (which first expires stale ones), maps rows through `toOpportunityView` (`lib/opportunity-ui.ts`) and renders `OpportunitiesView` (`components/dashboard/opportunities/opportunities-view.tsx`).

What the user sees and can do:

- **Filters**: status group (`Open`, `Accepted`, `Rejected & expired`, `All`, each with a count), type and source (only values that occur are offered), and sort (`Priority`, `Newest`, `Closing soonest`, `Confidence`). Default: Open, sorted by priority. Whatever the sort, open opportunities come before accepted, then closed ones.
- **Each card**: status badge (`New`, `Reviewed`, `Recommended`, `Accepted`, `Rejected`, `Expired`), priority and confidence badges, "Why Aura identified this" (the detector's rationale, then the rule's criteria, then advisor timing), confidence reason, angle, days left in the relevance window, who/what detected it (`Rule: competitor move`, `AI analysis (<model>)`, `Advisor rules (no AI)`, `AI advisor (<model>)`), AI warnings.
- **Evidence list**: each piece shows its kind ("Competitor change", "Market story", ...), the observation, a link to the Aura page that holds the underlying record (for example `/dashboard/competitors`, `/dashboard/trends`, `/dashboard/memory`), the original external link (http/https only), and, when it came through the signal store, the signal's source, reliability, reliability reason, sighting count, and whether it has expired. For AI-detected opportunities it also shows how the model said the signal supports the opportunity.
- **Actions** (only when the user has `company:update`): `Mark reviewed`, `Recommend`, `Accept`, `Reject` (with an optional note), `Reopen` (REJECTED back to REVIEWED). `EXPIRED` is never offered to a person (`personTransitions`). `Recommend` calls `POST /api/opportunities/:id/recommendations` (the recommendation engine creates a recommendation, which moves the opportunity to `RECOMMENDED`); every other action calls `POST /api/opportunities/:id/status`.
- **Next step**: for an accepted opportunity, a link that depends on its type (`nextStepFor`): trending topic, content gap and seasonal moment open `/dashboard/content/new?brief=...`; competitor move and competitive gap open `/dashboard/competitors`; channel opens `/dashboard/connectors`; performance pattern and other open `/dashboard/planner`; audience segment opens `/dashboard/business`.
- **History**: every status change with from/to, note and whether a person made it.
- **"Look for new opportunities"** button (only with `company:update`): calls `POST /api/opportunities/detect` and reports how many were created or reopened.
- `?focus=<id>` scrolls to that opportunity and, if it is closed, switches the filter to `All` so it is visible. The advisor page links here this way.
- Empty state: "No opportunities yet", with the detect button.

### Campaign ideas (advisor) page: `/dashboard/advisor`

Server page `app/dashboard/advisor/page.tsx` loads the latest `AdvisorReport` and renders `AdvisorView` (`components/dashboard/advisor/advisor-view.tsx`).

- Shows the report summary, when it was generated and by what (`rule-based (no AI provider configured)` or `AI: <model>`), and a coverage line: competitor observations, tracked competitors, trend items, learned insights and recent drafts, plus what was skipped and why.
- One card per campaign opportunity: impact and effort badges, rationale, angle, channels, content ideas, timing, expandable evidence, and a link to `/dashboard/opportunities?focus=<opportunityId>` when it was stored.
- "Where competitors are active and you aren't": the report's competitive gaps.
- `Find opportunities` / `Regenerate` button, shown only with `content:create`; calls `POST /api/advisor`.
- Header links to `/dashboard/opportunities`, `/dashboard/competitors` and `/dashboard/trends`.

### Roles

| Action | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- |
| View opportunities, signals, advisor report | yes | yes | yes | yes |
| Generate advisor report (`content:create`) | yes | yes | yes | no |
| Run detection, refresh signals, change status, recommend (`company:update`) | yes | yes | no | no |

## 3. How it works

### 3.1 Signal collection (`collectSignals`)

1. Load the Business Context (`getBusinessContext`). No context means no collection (returns `null`).
2. Read the 5 sources in parallel, looking back `sinceDays` (default 30). A source that throws is skipped and reported in `failed`; the rest still run.

| Source | Read from | Signals produced | Reliability | Expires after |
| --- | --- | --- | --- | --- |
| `TRENDS` | Up to 30 `TrendDigest` rows since the cutoff, items in `payload` | One per story (`TREND_ITEM`), `refId` = `<digestId>:<itemId>` | `news` and `hackernews` MEDIUM; `reddit` and `twitter` LOW | 14 days |
| `COMPETITORS` | Competitors with `trackingEnabled`, up to 10 snapshots each since the cutoff | One per change in `changesSummary`: homepage, pricing (HIGH, seen on their site), release (HIGH, GitHub), current positioning baseline (MEDIUM), each news item (MEDIUM) | as listed | 30 days |
| `ANALYTICS` | Latest 2 `AnalyticsReport` rows | One per metric that moved at least 25% **and** at least 3 in absolute terms (`ANALYTICS_THRESHOLD`), HIGH. With only one period: one summary signal, MEDIUM | as listed | 45 days |
| `MEMORY` | Up to 50 active `MarketingMemory` rows | One per insight; rows whose summary status is `insufficient` or with empty insight are skipped | The insight's own confidence; HIGH if the user edited/confirmed it | 60 days |
| `BUSINESS_CONTEXT` | The loaded Business Context | One per campaign (expires on the campaign end date), one for the current goal, one per preferred channel that is not connected | HIGH if the fact is trusted and not stale, else LOW; unconnected channel always HIGH | none (campaign: its end date) |

3. Every signal is matched against the Business Context (`matchContext`): market keywords, competitor names, audience industries and the business's own industry, as whole-word matches of at least 3 characters. Results are stored in `contextMatches` (for example `keyword:pricing`, `competitor:Acme`).
4. `mergeBatch` collapses the batch so each `dedupeKey` appears once, keeping the earliest `observedAt`, the latest `expiresAt`, the union of context matches, the highest strength, and the list of distinct records it was seen in (`sightings`). Dedupe keys: a trend story is its canonical URL (no protocol, `www`, tracking params `utm_*`, `ref`, `fbclid`, `gclid`, `mc_*`, or trailing slash) or else its first 16 title words; competitor changes are keyed by competitor, change type and the first 24 words of the text.
5. **Corroboration**: more than one sighting raises reliability one step (`corroborate`), never above HIGH, and appends `seen N times` to the reliability reason. At most 20 sightings are remembered per signal (`MAX_SIGHTINGS`).
6. New keys are inserted with `createMany({ skipDuplicates: true })`; known keys are updated (sightings merged, `lastSeenAt` set, earliest `observedAt` and latest `expiresAt` kept). Collection is idempotent. Returns `{ created, updated, bySource, failed }`.

`listSignals` returns signals newest first (`lastSeenAt`, then `observedAt`), excluding expired ones unless `includeExpired`, with optional filters by source, minimum reliability, `relevantOnly` (non-empty `contextMatches`) and a limit (default 100).

### 3.2 Rule-based detection (`runDetection`)

`runDetection` (optionally collecting first) reads up to 500 current signals, the history of rule-made opportunities that were accepted or rejected, and the signal ids used as evidence in rejected opportunities. It then runs `detectOpportunities`.

The 5 rules (`DETECTION_RULES`):

| Rule id | Type | Fires when | Impact / effort | Dedupe key bucket |
| --- | --- | --- | --- | --- |
| `competitor-move` | `COMPETITOR_MOVE` | A HIGH-reliability competitor `pricing`, `homepage` or `release` change in the last 30 days; grouped per competitor | high if pricing changed, else medium / low | competitor + month (`YYYY-MM`) |
| `trending-topic` | `TRENDING_TOPIC` | Trend stories in the last 14 days grouped by matched business keyword or industry; needs 2 different stories or 1 story with `occurrences >= 2`, and at least one not LOW | high if the topic matches a running campaign theme, else medium / low | topic + ISO week |
| `proven-pattern` | `PERFORMANCE_PATTERN` | A `MEMORY` signal that is not LOW | medium / low | memory record |
| `results-shift` | `PERFORMANCE_PATTERN` | A HIGH `ANALYTICS` signal with a metric (25%+ move between two periods) | drop: high, jump: medium / medium | metric + direction + report |
| `unconnected-channel` | `CHANNEL` | A `BUSINESS_CONTEXT` signal for an unconnected channel | low / low; no expiry | channel |

Shared gates, in order, applied to every candidate:

1. **Muted rule**: a rule with 3 or more rejections and no acceptance in the last 60 days is muted for 30 days after its latest rejection (`RULE_MUTING`). Suppression reason `rule-muted`.
2. **Evidence**: a candidate with no current signal is `insufficient-evidence` (expired signals never reach the rules).
3. **Relevance**: a `TRENDING_TOPIC` candidate whose stories have no context match is `not-relevant`.
4. **No repeat of a rejection**: evidence already used in a rejected opportunity is removed; if nothing is left, `already-rejected`.
5. **Duplicates within a run**: a candidate of the same type that shares any signal with one already accepted is merged into it (`duplicate`). Trending topics are sorted most specific first (business keyword before industry, longer phrase first), so the more specific one keeps the evidence.

Confidence from reliability (`confidenceFromReliability`): HIGH = 2+ signals, at least one HIGH, none LOW; MEDIUM = at least one HIGH or 2+ MEDIUM-or-better; otherwise LOW.

Before recording, `runDetection` looks for an **open opportunity of the same type that already cites one of the same records** (same `kind` and `refId`, found by the advisor, AI detection or an earlier period of the same rule) and records into its `dedupeKey` instead (reported as `mergedInto`). Each recorded candidate has `source` set from its first signal's source and `detectedBy` = `rule:<id>`. The run returns `outcomes`, `suppressed`, `mutedRules` and `signalsRead`.

### 3.3 AI-assisted detection (`runAiDetection`)

Covers only the 3 categories in `AI_INTERPRETED_CATEGORIES`: `CONTENT_GAP`, `COMPETITIVE_GAP`, `AUDIENCE_SEGMENT`.

1. Load the Business Context Snapshot with `view: 'opportunity'` (see [../05-business-context](../05-business-context/)). No snapshot returns `null`.
2. No AI provider configured: status `skipped`, no call.
3. Select signals (`selectSignalsForAi`): current, not used in a rejected opportunity, trends only if they match the business; most reliable then most recent first; at most 40 (`AI_DETECTION_LIMITS.maxSignals`). Fewer than 2 (`MIN_SIGNALS`): `skipped`.
4. Build the prompt (`buildAiDetectionPrompt`, version `ai-detect-v1`): the snapshot text, the citable fact keys (unconfirmed ones labelled `ASSUMPTION`), and signals labelled `S1`, `S2`, ... The call is `completeStructured` with tier `standard`, effort `medium`, `maxTokens` 4000.
5. Validate each returned item (`validateAiOutput`); an item that fails is rejected with reasons, the rest still count:

| Check | Rejection code |
| --- | --- |
| Matches `aiOpportunitySchema` (title 3-160, summary 10-1500, reasoning 10-2000, at least 1 citation, confidence and its reason present) | `invalid-shape` |
| Type is one of the 3 AI categories | `type-not-allowed` |
| Every cited reference is a supplied signal | `unknown-signal` |
| Enough cited signals of the right source: `CONTENT_GAP` 1 from COMPETITORS/TRENDS; `COMPETITIVE_GAP` 2 from COMPETITORS/TRENDS; `AUDIENCE_SEGMENT` 1 from ANALYTICS/MEMORY | `insufficient-evidence` |
| Every business fact relied on exists in the snapshot | `unknown-business-fact` |
| No declared assumptions | `declared-assumption` |
| Every percentage, money amount or number of 10 or more appears in a cited signal or the snapshot (small counts and the current year +/- 1 allowed) | `unsupported-number` |
| Not the same type over the same signals as one already accepted | `duplicate` |
| At most 5 accepted per run | `over-limit` |

   More than 8 citations are trimmed to 8 with a warning. Stored confidence is the lower of the model's claim and `confidenceFromReliability` of the cited signals.
6. Each accepted item is recorded with `source: 'AI_DETECTION'`, `detectedBy: 'ai:<model>'`, `dedupeKey: 'ai:<TYPE>:<first 10 title words>'`, evidence = the cited signals themselves, and model details in `details.ai`. The same cross-detector merge as the rules applies.
7. Status: `ok`, `partial` (some stored, some rejected), `rejected` (all rejected), `failed` (call or envelope failed, nothing stored), `skipped`. Every run that reaches the model writes an `OPPORTUNITY_AI_DETECTION_RUN` audit entry with status, model, prompt version, snapshot fingerprint, counts, and up to 20 rejections.

### 3.4 The advisor (`generateAdvisorReport`)

1. Gathers evidence from the last 30 days (`LOOKBACK_DAYS`): competitor snapshots (up to 4 per competitor), up to 5 trend digests (at most 15 trend items, 6 per digest), up to 20 recent drafts (as "already covered"), up to 8 active memory insights.
2. No competitor or trend evidence: an honest empty report (`model: 'none'`, no opportunities).
3. No AI provider: `deterministicOpportunities`, one per competitor (up to 3) and up to 2 trend items, plus a single competitor-messaging gap.
4. Otherwise one `completeStructured` call (effort `high`, `maxTokens` 3000) with the Business Context (identity, audience, channels, voice) and numbered evidence; at most 6 opportunities (`MAX_OPPORTUNITIES`) and 4 gaps. Opportunities citing no supplied evidence are dropped; if none remain, or the call fails, it falls back to the deterministic version.
5. Then, each best-effort (a failure is logged, never stops the report): `expireOpportunities`, `collectSignals`, `runDetection`, `runAiDetection`, and `recordOpportunity` for each advisor opportunity (`advisorToOpportunityInput`: type inferred from evidence kinds, `source: 'ADVISOR'`, `detectedBy` = model or `deterministic`, context fields `identity.description`, `audience.stated`, `audience.marketMode`).
6. Upserts the day's `AdvisorReport` (unique per company and UTC day) and writes an `ADVISOR_REPORT_GENERATED` audit entry.

### 3.5 Recording, confidence and priority (`recordOpportunity`)

- Input validated by `opportunityInputSchema`: title 3-200 chars, summary up to 4000, **1 to 50 pieces of evidence** (an opportunity with none is refused), evidence URLs must be http(s).
- `dedupeKey` defaults to `<TYPE>:<first 12 title words>`. `relevantUntil` defaults from the type: trending topic 14 days, competitor move 30, seasonal moment 30, content gap 60, performance pattern 60, other 60, competitive gap 90, audience segment 120, channel 120.
- **Confidence** (`deriveConfidence`): 1 distinct signal LOW, 2+ MEDIUM, 3+ from 2+ kinds HIGH; never above the detector's claim; capped at MEDIUM when a relied-on context field is untrusted, stale or missing (`shakyContextFields`).
- **Priority** (`derivePriority`): score = impact x 22 + (4 - effort) x 8 + confidence x 6 (levels 1-3), normalised from 36..108 to 0..100. LOW confidence caps the score at 65 and the priority at MEDIUM. Otherwise URGENT if 7 days or fewer remain and score is at least 50 (score +10, max 100); HIGH at 66+, MEDIUM at 33+, else LOW.
- New key: create the opportunity, its evidence rows (`fingerprint` = first 32 hex chars of SHA-256 of kind, refId and normalised detail) and a `DETECTED` event, in one transaction.
- Existing key that is `ACCEPTED` or `REJECTED`: **skipped**, a re-detection never overrides a person's decision.
- Existing open key: new evidence added (duplicates skipped by fingerprint), confidence and priority recomputed over all evidence, `relevantUntil` extended to the later date, `lastSeenAt` updated.
- Existing `EXPIRED` key: reopened to `DETECTED` with an `EXPIRED -> DETECTED` event ("Detected again with fresh evidence.").

### 3.6 Lifecycle

`TRANSITIONS` in `lib/opportunities.ts`:

| From | Allowed to |
| --- | --- |
| `DETECTED` | `REVIEWED`, `RECOMMENDED`, `ACCEPTED`, `REJECTED`, `EXPIRED` |
| `REVIEWED` | `RECOMMENDED`, `ACCEPTED`, `REJECTED`, `EXPIRED` |
| `RECOMMENDED` | `ACCEPTED`, `REJECTED`, `EXPIRED` |
| `ACCEPTED` | none (final) |
| `REJECTED` | `REVIEWED` (reopen) |
| `EXPIRED` | none by hand; only re-detection reopens it to `DETECTED` |

`transitionOpportunity` does a compare-and-swap on the current status (a disallowed move or a concurrent change returns 409), stamps `reviewedAt` / `recommendedAt` / `decidedAt` + `decidedById` + `decisionNote` / `expiredAt`, clears the earlier decision on reopen, writes an `OpportunityEvent`, and mirrors `ACCEPTED`, `REJECTED` and `EXPIRED` onto any of its recommendations still `GENERATED` or `PRESENTED` (with a `RecommendationEvent`, `source: 'opportunity'`).

`expireOpportunities` moves every open opportunity whose `relevantUntil` has passed to `EXPIRED` (same compare-and-swap, an event, and mirroring). It runs before every list (`listOpportunities`, `listOpportunitiesForView`) and at the start of each advisor run; there is no separate expiry job.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/opportunities/page.tsx` | Loads opportunities for the view, computes `canAct` (`company:update`), handles `?focus=` |
| Page | `app/dashboard/advisor/page.tsx` | Loads the latest advisor report, computes `canGenerate` (`content:create`) |
| Component | `components/dashboard/opportunities/opportunities-view.tsx` | Filters, cards, evidence, actions, history, detect button |
| Component | `components/dashboard/advisor/advisor-view.tsx` | Report summary, coverage, campaign cards, gaps, generate button |
| API | `app/api/signals/route.ts` | `GET` signals with filters |
| API | `app/api/signals/refresh/route.ts` | `POST` run collection now |
| API | `app/api/opportunities/route.ts` | `GET` opportunities (expires stale first) |
| API | `app/api/opportunities/detect/route.ts` | `POST` collect + rules + AI detection + auto-suggest |
| API | `app/api/opportunities/[id]/route.ts` | `GET` one opportunity with evidence, history and recommendations |
| API | `app/api/opportunities/[id]/status/route.ts` | `POST` lifecycle transition |
| API | `app/api/opportunities/[id]/recommendations/route.ts` | `GET` recommendations of an opportunity; `POST` generate one with the recommendation engine |
| API | `app/api/opportunities/[id]/handoff/route.ts` | `GET` the opportunity-to-recommendation hand-off contract |
| API | `app/api/advisor/route.ts` | `GET` latest report; `POST` generate today's report |
| API (cron) | `app/api/cron/advisor/route.ts` | `GET`/`POST` advisor report for every workspace, `CRON_SECRET` bearer |
| Service | `server/signals/signal.service.ts` | `collectSignals`, `mergeBatch`, `listSignals`, `asStoredSignal` |
| Service | `server/signals/normalize.ts` | One pure normaliser per source; `ANALYTICS_THRESHOLD` |
| Service | `server/opportunities/opportunity.service.ts` | `recordOpportunity`, `transitionOpportunity`, `expireOpportunities`, list/get, `opportunityBelongsTo`, `opportunitiesForSignal` |
| Service | `server/opportunities/detection.service.ts` | `runDetection` (history, muting, cross-detector merge, recording) |
| Service | `server/opportunities/ai-detection.service.ts` | `runAiDetection` (snapshot, model call, validation, recording, audit) |
| Service | `server/opportunities/from-advisor.ts` | `advisorOpportunityType`, `advisorToOpportunityInput` |
| Service | `server/advisor/advisor.service.ts` | `generateAdvisorReport`, `getLatestAdvisorReport` |
| Types | `server/advisor/types.ts` | `AdvisorPayload`, `CampaignOpportunity`, `OpportunityEvidence`, `CompetitiveGap`, `AdvisorCoverage` |
| Lib | `lib/signals.ts` | Signal sources, reliabilities, expiry per source, `canonicalUrl`, `textKey`, `corroborate`, `matchContext`, `signalToEvidence` |
| Lib | `lib/opportunities.ts` | Types, statuses, priorities, sources, signal kinds, `TRANSITIONS`, input schemas, `dedupeKeyFor`, `deriveConfidence`, `derivePriority` |
| Lib | `lib/opportunity-detection.ts` | The 5 rules, `confidenceFromReliability`, `RULE_MUTING`, `detectOpportunities`, `candidateToInput` |
| Lib | `lib/ai-opportunity-detection.ts` | Prompt, limits, evidence requirements, output schema, `validateAiOutput`, `unsupportedNumbers`, `aiToOpportunityInput` |
| Lib | `lib/opportunity-ui.ts` | View model, labels, next steps, filtering and sorting |
| Tests | `tests/signals.test.ts`, `tests/opportunities.test.ts`, `tests/opportunity-detection.test.ts`, `tests/ai-opportunity-detection.test.ts`, `tests/opportunity-ui.test.ts` | Unit tests for the pure modules |
| Verify | `scripts/verify-signals.ts`, `scripts/verify-opportunities.ts`, `scripts/verify-detection.ts`, `scripts/verify-ai-detection.ts`, `scripts/verify-access.ts` | Real-database checks |

## 5. Data model

All in `prisma/schema.prisma`. Every model is scoped by `companyId` and cascades on company delete.

| Model / enum | Key fields | Notes |
| --- | --- | --- |
| `Signal` | `source`, `kind`, `title`, `summary`, `url`, `refId`, `sightings[]`, `occurrences`, `observedAt`, `firstSeenAt`, `lastSeenAt`, `expiresAt`, `reliability`, `reliabilityReason`, `strength`, `contextRevision`, `contextMatches[]`, `metadata` (JSON), `dedupeKey` | Unique `(companyId, dedupeKey)`; indexes `(companyId, source, observedAt)`, `(companyId, lastSeenAt)` |
| `Opportunity` | `type`, `status` (default `DETECTED`), `title`, `summary`, `rationale`, `angle`, `details` (JSON), `source`, `detectedBy`, `priority`, `priorityScore` (0-100), `confidence`, `confidenceReason`, `impact`, `effort`, `dedupeKey`, `detectedAt`, `lastSeenAt`, `relevantUntil`, `statusChangedAt`, `reviewedAt`, `recommendedAt`, `decidedAt`, `decidedById`, `decisionNote`, `expiredAt`, `contextRevision`, `contextFingerprint`, `contextFields[]` | Unique `(companyId, dedupeKey)`; indexes `(companyId, status)`, `(companyId, relevantUntil)`; has many `OpportunitySignal`, `OpportunityEvent`, `Recommendation` |
| `OpportunitySignal` | `opportunityId`, `kind`, `refId`, `label`, `detail`, `url`, `observedAt`, `fingerprint`, `signalId` | Unique `(opportunityId, fingerprint)`; `signalId` is `SetNull` on signal delete, so evidence survives; index `(kind, refId)` |
| `OpportunityEvent` | `opportunityId`, `fromStatus`, `toStatus`, `actorId` (null = system), `note`, `createdAt` | Lifecycle history |
| `AdvisorReport` | `companyId`, `date` (UTC day start), `payload` (JSON `AdvisorPayload`), `model`, `generatedAt` | Unique `(companyId, date)` |
| `OpportunityType` | `TRENDING_TOPIC`, `COMPETITOR_MOVE`, `COMPETITIVE_GAP`, `CONTENT_GAP`, `SEASONAL_MOMENT`, `AUDIENCE_SEGMENT`, `CHANNEL`, `PERFORMANCE_PATTERN`, `OTHER` | |
| `OpportunityStatus` | `DETECTED`, `REVIEWED`, `RECOMMENDED`, `ACCEPTED`, `REJECTED`, `EXPIRED` | |
| `OpportunityPriority` | `LOW`, `MEDIUM`, `HIGH`, `URGENT` | |
| `OpportunityConfidence` | `LOW`, `MEDIUM`, `HIGH` | |
| `OpportunitySource` | `ADVISOR`, `TRENDS`, `COMPETITORS`, `MEMORY`, `ANALYTICS`, `BUSINESS_CONTEXT`, `AI_DETECTION`, `MANUAL` | |
| `OpportunitySignalKind` | `COMPETITOR_SNAPSHOT`, `TREND_ITEM`, `MEMORY_INSIGHT`, `CONTENT_DRAFT`, `ANALYTICS_REPORT`, `KNOWLEDGE_CHUNK`, `LEAD_SIGNAL`, `BUSINESS_CONTEXT`, `EXTERNAL` | Shared by `Signal.kind` and `OpportunitySignal.kind` |
| `SignalSource` | `TRENDS`, `COMPETITORS`, `ANALYTICS`, `MEMORY`, `BUSINESS_CONTEXT` | |
| `SignalReliability` | `LOW`, `MEDIUM`, `HIGH` | |

Models read, not owned: `TrendDigest`, `CompetitorProfile` / `CompetitorSnapshot`, `AnalyticsReport`, `MarketingMemory`, `ContentDraft`, `Company`, and `Recommendation` / `RecommendationEvent` (written only by status mirroring).

## 6. API endpoints

See also [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md). All routes resolve the active workspace with `requireActiveCompany`; errors go through `handleRouteError`.

| Method | Path | Purpose | Auth/permission |
| --- | --- | --- | --- |
| GET | `/api/signals` | Signals, newest first. Query: `source` (comma list), `min` (reliability), `relevant` and `expired` (`1`/`0`/`true`/`false`), `limit` 1-500 (default 100) | Any member |
| POST | `/api/signals/refresh` | Collect signals now; returns `{ created, updated, bySource, failed }` | `company:update` (403 otherwise) |
| GET | `/api/opportunities` | Opportunities with evidence, open first by priority. Query: `status` (comma list), `limit` 1-200 (default 50) | Any member |
| POST | `/api/opportunities/detect` | Collect, run rules, then AI detection (skip with `?ai=0`), then `suggestFromOpportunities` with a 25 s budget. Returns the rule run plus `ai` and `suggestions`. `maxDuration` 60 | `company:update` |
| GET | `/api/opportunities/:id` | One opportunity with evidence, history and its recommendations | Any member; 404 if not in the workspace |
| POST | `/api/opportunities/:id/status` | Body `{ status, note? }` (note max 2000). 409 on a disallowed or concurrent change | `company:update` |
| GET | `/api/opportunities/:id/recommendations` | Recommendations made from it | Any member; 404 if not in the workspace |
| POST | `/api/opportunities/:id/recommendations` | Generate a recommendation (optional content overrides). 201 with `{ recommendation, generation }`; 422 if the data supports none | `company:update` |
| GET | `/api/opportunities/:id/handoff` | Hand-off contract for the recommendation engine | Any member; 404 if not in the workspace |
| GET | `/api/advisor` | Latest advisor report, or `null` | Any member |
| POST | `/api/advisor` | Generate today's report; returns `{ opportunities (count), model, coverage }`. `maxDuration` 60 | `content:create` |
| GET/POST | `/api/cron/advisor` | Generate the advisor report for every company | `Authorization: Bearer $CRON_SECRET` |

## 7. External services

- **AI provider** via `server/ai/claude.ts` (`completeStructured`): Anthropic when `ANTHROPIC_API_KEY` is set, otherwise Gemini when `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` is set. Used by AI detection (tier `standard`) and the advisor. Without either key, AI detection is `skipped` and the advisor uses its deterministic fallback; rule-based detection is unaffected.
- No other third-party API is called directly. Trends and competitor data are collected by their own features ([../06-trend-insights](../06-trend-insights/), [../07-competitor-intelligence](../07-competitor-intelligence/)) and only read here.

See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

- `app/api/cron/advisor/route.ts` runs `generateAdvisorReport` for every company (which also expires opportunities, collects signals and runs both detectors). It requires `CRON_SECRET` and exports `GET = POST` for Vercel Cron. Its comment gives the example schedule `0 6 * * 1`, but **it is not listed in `vercel.json`** (which schedules only `/api/cron/publish`, `/api/cron/briefing` and `/api/cron/connections`), so it runs only if scheduled elsewhere or called manually.
- Expiry of opportunities is not a separate job; it happens lazily before each list and at the start of an advisor run.
- `POST /api/opportunities/detect` triggers auto-suggestions (`suggestFromOpportunities`) inline.

## 9. Security & permissions

- **Workspace scoping**: every query filters by `companyId` from `requireActiveCompany`. Lookups by id use `findFirst({ id, companyId })`, so another workspace's id behaves exactly like a missing one (404); `opportunityBelongsTo` guards the recommendations route. Covered by `pnpm verify:access` (see `docs/DATA-ACCESS-SECURITY.md`).
- **RBAC** (`lib/rbac.ts`): `company:update` (OWNER, ADMIN) for detection, signal refresh, status changes and recommending; `content:create` (OWNER, ADMIN, MEMBER) for generating the advisor report. Read routes need only membership. The UI hides buttons for users without the permission.
- **Validation**: Zod schemas on every query and body; opportunity input (`opportunityInputSchema`) requires 1-50 evidence items; evidence URLs must be http(s) (`isWebUrl`) and are re-checked before rendering as links.
- **Concurrency**: status changes and expiry use compare-and-swap (`updateMany` on the current status), so two simultaneous decisions cannot both win.
- **AI output**: never trusted directly; validated against supplied signals and snapshot facts before anything is stored, with rejections audited.
- **Audit**: `ADVISOR_REPORT_GENERATED` and `OPPORTUNITY_AI_DETECTION_RUN` via `recordAudit`.

## 10. Testing

| Kind | File / script | Covers |
| --- | --- | --- |
| Unit | `tests/signals.test.ts` | Canonical URLs, text keys, corroboration, context matching, normalisers |
| Unit | `tests/opportunities.test.ts` | Transitions, dedupe keys, confidence and priority derivation |
| Unit | `tests/opportunity-detection.test.ts` | Each rule, gates, muting, merging |
| Unit | `tests/ai-opportunity-detection.test.ts` | Signal selection, prompt, validation codes, number checks |
| Unit | `tests/opportunity-ui.test.ts` | View model, next steps, filtering and sorting |
| DB | `pnpm verify:signals` | Collection from every source, no duplicates, consumable by detection |
| DB | `pnpm verify:opportunities` | Storage, merge on re-detection, decisions not overridden, expiry/reopen, history, concurrent decisions |
| DB | `pnpm verify:detection` | End-to-end collect, detect, record; no duplicates; rejected not re-proposed; cross-detector merge |
| DB | `pnpm verify:ai-detection` | Scripted model responses through every validation and fallback path |
| DB | `pnpm verify:access` | Cross-workspace access to signals and opportunities |

## 11. Configuration & limits

| Setting | Value | Where |
| --- | --- | --- |
| Signal lookback | 30 days (`sinceDays`) | `signal.service.ts` |
| Max sightings per signal | 20 | `MAX_SIGHTINGS` |
| Signal expiry | trends 14, competitors 30, analytics 45, memory 60 days; business context none | `SIGNAL_SOURCE_INFO` |
| Analytics threshold | 25% and 3 absolute | `ANALYTICS_THRESHOLD` |
| Signals read per detection run | 500 | `runDetection`, `runAiDetection` |
| Rule muting | 3 rejections, 60-day window, 30-day mute | `RULE_MUTING` |
| AI detection | 40 signals, 5 opportunities, 8 citations, min 2 signals, 4000 tokens, prompt `ai-detect-v1` | `AI_DETECTION_LIMITS`, `MIN_SIGNALS` |
| Advisor | 30-day lookback, 6 opportunities, 4 gaps, 3000 tokens, effort high | `advisor.service.ts` |
| Evidence per opportunity | 1-50 | `opportunityInputSchema` |
| API limits | signals 1-500 (default 100); opportunities 1-200 (default 50); view loads 200 | route schemas, `listOpportunitiesForView` |
| Env vars | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY`, `CRON_SECRET` | |

## 12. Known limitations & future work

- The advisor cron route exists but is not scheduled in `vercel.json`; signals and opportunities refresh only when someone runs detection, refreshes signals, or generates advisor advice.
- Nothing prunes old `Signal` rows; expired signals are only filtered out of reads. (Evidence links use `SetNull` so a future prune would not break opportunities.)
- `SEASONAL_MOMENT` has a type and relevance window but no rule or AI category produces it. `MANUAL` is a source value with no route that creates manual opportunities.
- Signal kinds `KNOWLEDGE_CHUNK` and `LEAD_SIGNAL` exist but no collector produces them.
- Advisor evidence and signal-store evidence are collected separately (the advisor has its own `collectSignal`), so advisor opportunities link to records (`refId`) but not to `Signal` rows (`signalId`).
- Competitor signals are collected only for competitors with `trackingEnabled`; the advisor reads all competitor profiles.
- Detection is synchronous inside request handlers (`maxDuration` 60 s).

## 13. Related documents

- [../../../SIGNAL-AGGREGATION.md](../../../SIGNAL-AGGREGATION.md)
- [../../../OPPORTUNITY-MODEL.md](../../../OPPORTUNITY-MODEL.md)
- [../../../OPPORTUNITY-DETECTION-RULES.md](../../../OPPORTUNITY-DETECTION-RULES.md)
- [../../../AI-OPPORTUNITY-DETECTION.md](../../../AI-OPPORTUNITY-DETECTION.md)
- [../../../OPPORTUNITY-RECOMMENDATION.md](../../../OPPORTUNITY-RECOMMENDATION.md)
- [../../../DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md)
- [../../../PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md)
- Sibling features: [../05-business-context](../05-business-context/), [../06-trend-insights](../06-trend-insights/), [../07-competitor-intelligence](../07-competitor-intelligence/), [../09-recommendations-and-aura-suggests](../09-recommendations-and-aura-suggests/), [../10-aura-home-and-briefing](../10-aura-home-and-briefing/)
- Architecture: [02-ARCHITECTURE.md](02-ARCHITECTURE.md)
