# Recommendations & Aura Suggests

> Recommendations are what Aura proposes a business **do** about an open opportunity: a concrete action, why it matters now, the expected outcome, the evidence behind it, a channel and audience where they apply, and a lifecycle with full history. A rules-first engine picks the action (a model may only reword it, and its output is validated), guardrails stop floods, duplicates and unsupported advice, a quality gate runs before anything is shown, and "Aura Suggests" presents the result in plain language, ranked for *now*, with one next step that hands the recommendation (and its context) to the Aura module that carries it out. It exists so the product moves from "here is what we noticed" to "here is what to do, and why", without inventing anything the data does not support.

## 1. Overview

The feature sits between Opportunities and Creation in the Aura pipeline:

```
Opportunity (open, with current evidence)
  -> hand-off (lib/recommendation-handoff.ts)
  -> engine: select action -> write (template or validated model) -> assess -> support gate
  -> guardrails: frequency, duplicates, muting, conflicts, executability
  -> Recommendation row + RecommendationEvidence + RecommendationEvent("generate")
  -> quality check (8 checks) -> ranking (computed on read)
  -> Aura Suggests / Aura Home -> decision (accept / edit / skip / reject / not now)
  -> creation hand-off to Content Studio, Campaigns, Outreach, Content Plan, Connectors...
```

Main concepts:

| Concept | Where | Summary |
| --- | --- | --- |
| Recommendation | `lib/recommendations.ts`, `Recommendation` model | What / Why / Action / Expected outcome / Evidence / Confidence / Priority / Channel / Audience / Status. Always linked to one opportunity. |
| Engine | `lib/recommendation-engine.ts`, `server/recommendations/engine.service.ts` | Deterministic action selection per opportunity type, template writing, optional model rewrite, assessment, support gate. Version `rec-engine-v1`. |
| Rules & guardrails | `lib/recommendation-rules.ts` | Minimum evidence, confidence rules, frequency limits, duplicates, muting, channel/integration support, expiry, conflicts, executability. |
| Ranking | `lib/recommendation-ranking.ts`, `ranking.service.ts` | Score + band (now / next / later / hidden), factor-by-factor explanation, "Not now" snooze. Never stored. |
| Quality | `lib/recommendation-quality.ts`, `quality.service.ts` | Eight checks right before presentation; verdict trusted / needs_review / blocked. |
| Aura Suggests | `lib/aura-suggests.ts`, `suggestions.service.ts`, `/dashboard/suggestions` | A recommendation in plain language: What, Why, Expected outcome, Based on, Next step. |
| Auto-suggest | `autosuggest.service.ts` | Runs the engine over open opportunities without a live suggestion, after detection or on demand. |
| Data readiness | `lib/data-readiness.ts`, `readiness.service.ts` | Whether Aura has enough to recommend (ready / limited / blocked) and the one next step. |
| Modules & routing | `lib/aura-modules.ts` | Which module carries a recommendation out (`?rec=<id>`), and what it receives. |
| Context handoff | `lib/recommendation-context-handoff.ts` | Versioned, sourced payload (version 1) that creation workflows consume. |
| Creation | `lib/recommendation-creation.ts`, `creation.service.ts`, `lib/creation-handoff.ts` | What "Create" means for a recommendation and whether it can happen now. |
| History | `lib/recommendation-history.ts`, `history.service.ts`, `/dashboard/suggestions/history` | What was suggested and what the business did; repeat holds; learning candidates for Marketing Memory. |

## 2. User-facing behaviour

### Screens

| Route | File | What the user sees / can do |
| --- | --- | --- |
| `/dashboard/suggestions` | `app/dashboard/suggestions/page.tsx` | "Aura Suggests": waiting suggestions best first and accepted-but-not-started ones. Each card: what, why, expected outcome, "Based on" evidence (expandable), steps, a quality mark, and the next-step button (e.g. "Create content", "Plan the series", "Connect", "Add to your plan"), plus **Edit**, **Skip**, and a menu with **Not now — remind me in a week** and **Not for us — suggest fewer like this**. Links to History and Opportunities. |
| `/dashboard/suggestions` (empty states) | same + `components/dashboard/suggestions/readiness-panel.tsx`, `suggest-actions.tsx` | If there are open opportunities without suggestions: "No suggestions yet" with a **Get Aura's suggestions** button (calls `POST /api/recommendations/generate`). If nothing can be recommended: the readiness panel listing what Aura needs, in order, each with one next step (often a link to `/dashboard/business?ask=<field>#aura-questions`, or "detect opportunities"). |
| `/dashboard/suggestions` (held back) | same | Owners/admins see a collapsible "Held back by Aura's quality checks (N)" list with a plain reason per suggestion. |
| `/dashboard/suggestions/history` | `app/dashboard/suggestions/history/page.tsx` | Past suggestions with outcome badges (Accepted, Edited & accepted, In progress, Completed, Skipped, Turned down, Withdrawn, Expired), filter `?outcome=`, who decided and when, what was changed or created, the originating opportunity, and "patterns Aura is learning" (shown once at least `LEARNING_MIN_SAMPLE` = 4 answers form a pattern). |
| Any module page opened with `?rec=<id>` | `components/dashboard/recommendations/recommendation-context-bar.tsx` (mounted in `components/dashboard/dashboard-shell.tsx`) | A context bar showing which recommendation the person is working on, what to do in this module, and links to related modules. |
| Campaign / outreach creation pages | `components/dashboard/recommendations/creation-context-panel.tsx` (used by `app/dashboard/campaigns/new/page.tsx`, `app/dashboard/campaigns/[id]/page.tsx`, `app/dashboard/outreach/new/page.tsx`) | Shows the recommendation context a campaign / outreach was created from. |

Aura Home also reads `getSuggestions` (see sibling feature [10-aura-home-and-briefing](../10-aura-home-and-briefing/01-FEATURE-DETAILS.md)).

### Roles

Roles come from `lib/rbac.ts`:

| Action | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- |
| View suggestions, history, readiness, details | yes | yes | yes | yes |
| Accept / edit / skip / reject / withdraw / change status / snooze (`company:update`) | yes | yes | no | no |
| Ask Aura for suggestions (`POST /generate`, `company:update`) | yes | yes | no | no |
| Start creation from an already-accepted recommendation (`content:create`) | yes | yes | yes | no |
| Start creation from an *open* suggestion (accepts it on the way, needs `company:update` too) | yes | yes | no | no |
| Have views recorded as "presented" (`content:create`) | yes | yes | yes | no (silently not recorded) |

The page itself computes `canAct = can(role, 'company:update')` and `canRecord = can(role, 'content:create')` and hides controls accordingly.

## 3. How it works

### 3.1 Recommendation shape and lifecycle (`lib/recommendations.ts`)

- **Types** (`RECOMMENDATION_TYPES`): `CONTENT`, `CAMPAIGN`, `COMPETITIVE_RESPONSE`, `AUDIENCE`, `CHANNEL`, `OPTIMIZATION`, `OTHER`. The natural type per opportunity type is `TYPE_FOR_OPPORTUNITY` (e.g. `TRENDING_TOPIC` -> `CONTENT`, `COMPETITOR_MOVE` -> `COMPETITIVE_RESPONSE`, `PERFORMANCE_PATTERN` -> `OPTIMIZATION`).
- **Statuses** (`RECOMMENDATION_STATUSES`): `GENERATED`, `PRESENTED`, `ACCEPTED`, `EDITED`, `SKIPPED`, `REJECTED`, `IN_PROGRESS`, `COMPLETED`, `WITHDRAWN`, `EXPIRED`.
- **Transitions** (`RECOMMENDATION_TRANSITIONS`): `GENERATED` -> any decision, `PRESENTED`, `WITHDRAWN`, `EXPIRED`; `PRESENTED` -> decisions, `WITHDRAWN`, `EXPIRED`; `ACCEPTED`/`EDITED` -> `EDITED`, `IN_PROGRESS`, `COMPLETED`, `WITHDRAWN`; `IN_PROGRESS` -> `COMPLETED`, `WITHDRAWN`. `SKIPPED`, `REJECTED`, `COMPLETED`, `WITHDRAWN`, `EXPIRED` are final.
- Groups: open = `GENERATED`, `PRESENTED` (only these expire); accepted = `ACCEPTED`, `EDITED`; live = open + accepted + `IN_PROGRESS` (an opportunity with a live recommendation cannot get another).
- **User-settable statuses** via `POST .../status`: `ACCEPTED`, `SKIPPED`, `REJECTED`, `IN_PROGRESS`, `COMPLETED`, `WITHDRAWN`. `PRESENTED`, `EDITED`, `EXPIRED` are set by Aura or by an edit.
- **History actions** (`RECOMMENDATION_ACTIONS`): `generate`, `present`, `accept`, `edit`, `skip`, `reject`, `start`, `complete`, `withdraw`, `expire`, `defer`, `link`. Sources (`EVENT_SOURCES`): `user`, `engine`, `system`, `opportunity`.
- **Status sync with the opportunity** (`RECOMMENDATION_TO_OPPORTUNITY` / `OPPORTUNITY_TO_RECOMMENDATION`): generated -> opportunity `RECOMMENDED`; accepted or edited -> `ACCEPTED`; rejected -> `REJECTED`; presented / skipped / in progress / completed / withdrawn / expired leave the opportunity alone. In reverse, an opportunity accepted / rejected / expired carries over to its open recommendation.
- **Outcome** (`recommendationOutcome`): the first decision is the answer; any `EDITED` in the history means "edited" (a yes with changes).
- **Editable fields** (`EDITABLE_FIELDS`): `title`, `summary`, `action`, `steps`, `rationale`, `expectedOutcome`, `outcomeMetric`, `channel`, `contentType`, `audience`. Evidence, link and assessment are never editable. `diffEdit` keeps only fields that really changed; an edit that changes nothing is a no-op (`changed: false`).
- **Content schema** (`recommendationContentSchema`): title <= 200 chars, summary <= 2000, action <= 500, up to 8 steps of <= 300, rationale <= 2000, expectedOutcome <= 1000, outcomeMetric <= 120, audience <= 600; `channel` must be one of `CONTENT_CHANNELS`, `contentType` one of `CONTENT_TYPES`.
- **Bounded by the opportunity** (`boundByOpportunity`): a recommendation may lower the opportunity's confidence but never raise it, and may shorten its relevance window but never extend it.
- **Default draft** (`draftFromOpportunity`): a full recommendation from templates (no model) used whenever a richer version is not available.
- **Execution brief** (`executionBrief`, version 1): the workflow (`CONTENT`, `PLANNER`, `COMPETITORS`, `CONNECTORS`, `BUSINESS_PROFILE`), the target `href` (or, when blocked, `/dashboard/opportunities?focus=<opportunityId>&rec=<id>`), brief text, channel, format, audience, `dueBy`, evidence, `executable` + `blockers`, `publishing: 'aura' | 'manual' | null`, and the primary module, verb and related modules.

### 3.2 Opportunity hand-off and eligibility (`lib/recommendation-handoff.ts`)

`getOpportunityHandoff` builds a versioned hand-off (`HANDOFF_VERSION = 1`) from the opportunity, its evidence and the live Business Context (shaky fields, whether context changed since detection). `handoffEligibility` refuses an opportunity that is not in an active status, whose relevance window has passed, or that has no current evidence.

### 3.3 Engine (`generateRecommendation` in `server/recommendations/engine.service.ts`)

1. **Inputs.** Load the hand-off; return `rejected` with eligibility reasons if not eligible. Throw 409 if the opportunity already has a live recommendation. Load the current Business Context Snapshot (`view: 'recommendation'`) and derive the `EngineContext` (channels published on, connected channels, confirmed audience, assumed audience, goals, campaign themes, learned formats).
2. **Frequency guardrail** (`FREQUENCY_LIMITS`): at most **10** new recommendations per workspace per rolling 24 h and **15** waiting for a decision. Over a limit, nothing is stored.
3. **Signals.** The opportunity's own evidence signals plus current `MEMORY` / `ANALYTICS` signals (up to 40). Learned formats from current signals are merged in.
4. **Select** (`selectActions`). Each opportunity type has a catalogue in `ACTIONS_FOR` (e.g. `TRENDING_TOPIC`: `post`, `series`; `CONTENT_GAP`: `article`, `post`, `series`; `COMPETITOR_MOVE`: `response-post`, `comparison-article`; `AUDIENCE_SEGMENT`: `targeted-post`, `update-audience`; `CHANNEL`: `connect-channel`; `PERFORMANCE_PATTERN`: `recovery-post` (needs an analytics drop), `apply-pattern` (needs a learned pattern or a rise); `OTHER`: `plan-it`). An action is set aside with its reasons if it needs a channel the business does not publish on, an audience nobody knows, more days than are left (`series` needs >= 7 days) or a bigger opening (`series` needs >= medium impact), or evidence that is missing. Viable actions are scored: base `50 - order*2`, +10 connected channel, +10 learned format, +10 matches goals/campaign themes, +10 low effort / -10 high effort, -15 for non-low effort when <= 7 days are left, +8 for a campaign on a high-impact opening.
5. **Guardrails on the choice** (`applyGuardrails`): too little evidence of the right kind (`MIN_EVIDENCE`: 1 current signal; `CAMPAIGN` 2; `COMPETITIVE_RESPONSE` 1 from `COMPETITORS`; `CHANNEL` 1 from `BUSINESS_CONTEXT`; `OPTIMIZATION` 1 from `ANALYTICS` or `MEMORY`), a muted action (same action + channel rejected **3+** times in **30** days with none accepted), or connecting a channel Aura cannot connect. If nothing is left: `rejected`, "No action this business can take is supported by the available data."
6. **Per-channel limit:** at most **5** recommendations for one channel per rolling 7 days.
7. **Write.** `composeRecommendation` produces a template version. If a model is configured (`isClaudeConfigured()`; Anthropic or Gemini), `completeStructured` is called with `tier: 'standard'`, `effort: 'medium'`, `maxTokens: 2000` and `aiRecommendationSchema`. `validateAiRecommendation` rejects model output that cites evidence it was not given, relies on a business fact not in the snapshot, declares assumptions, or states figures no source contains. On rejection or error the template is used and the flag "written from templates: the model's version was not supported by the data" is added. The model can change only the words, never type, channel, format or audience. `writtenBy` is `template` or `ai:<model>`.
8. **Overrides.** A person's overrides (when generated via `POST /api/opportunities/:id/recommendations`) are applied on top.
9. **Support gate** (`checkSupport`). Rejected if no evidence is current, an audience-targeted post has no audience, or a content/campaign/competitive recommendation names no channel. Flagged (stored, confidence capped) if the channel is not one the business uses, figures appear that no source contains, it relies on unconfirmed/out-of-date business fields, or the context changed since detection.
10. **Duplicates** (`findDuplicate`, `DUPLICATE_RULES`): same type and channel with title word overlap (Jaccard) >= **0.6** against one in play or made in the last **14** days, or rejected in the last **30** days.
11. **Assess** (`assess`): confidence starts at the opportunity's and is capped at `MEDIUM` when there are flags; priority from `derivePriority` (impact, chosen action effort, confidence, time left; High >= 66, Medium >= 33, Urgent needs score >= 50 with <= 7 days left, low confidence capped at 65).
12. **Conflicts** (`findConflicts`): a live recommendation for another opportunity that shares evidence with a different action, or answers the same competitor, is flagged on both sides, with the higher priority marked to go first.
13. **Executability** (`executability`): blocked when confidence is `LOW` (`LOW_CONFIDENCE_BLOCKER` until a person accepts it), the channel is not one the business uses, or a `CHANNEL` recommendation targets a channel without an available integration (`CHANNEL_INTEGRATIONS`: LinkedIn -> `linkedin`, Instagram -> `meta`, X -> `x`, YouTube -> `youtube`, Blog -> `wordpress`, Newsletter -> none; only connectors with status `available` count).
14. **Store** via `createRecommendationFromOpportunity`: relevance capped at **30** days from creation (`capRelevance`), engine bookkeeping in `details.engine` (version, writtenBy, snapshot fingerprint, selected, alternatives, unsupported, flags, priority reason). The opportunity moves to `RECOMMENDED`.
15. **Audit.** Every run, whatever its result, writes a `RECOMMENDATION_GENERATED` audit entry with status, reasons, flags and unsupported actions.

The report status is `created`, `flagged` (stored with flags) or `rejected`.

### 3.4 Automatic suggestions (`suggestFromOpportunities`)

- Runs after every detection (`POST /api/opportunities/detect`, with `budgetMs: 25_000`) and from "Get Aura's suggestions" (`POST /api/recommendations/generate`).
- First `mayWriteRecommendations`: refuses (`notReady`) if Aura does not know what the business does (description and offerings empty) or the business has not named any channel.
- Candidates (`openOpportunitiesWithoutSuggestion`): active opportunities with no live recommendation, ordered by `priorityScore desc, detectedAt desc`, minus those under a **repeat hold** (`REPEAT_HOLD_DAYS`: skipped 14 days, withdrawn 14 days, rejected 30 days).
- Defaults: `limit` 5 opportunities per run, `budgetMs` 40 000 ms; the rest is reported as `remaining`.
- After each recommendation is written, the quality check runs; a `blocked` verdict withdraws it immediately (source `system`, note "Failed Aura's quality checks: ...").
- One opportunity failing never stops the rest. A person pressing "Recommend" on an opportunity is never held back by a repeat hold.

### 3.5 Quality gate (`lib/recommendation-quality.ts`)

Eight checks (`QUALITY_CHECKS`), each `pass` / `warn` / `fail`: `schema`, `business_context`, `evidence`, `opportunity`, `actionability`, `expected_outcome`, `channel`, `confidence`. Verdict: `trusted` (all pass), `needs_review` (shown, marked, with what to check) or `blocked` (not shown). In `getSuggestions`, an open suggestion with a `blocked` verdict is moved to `heldBack` with `heldBackReason`.

### 3.6 Ranking for "now" (`lib/recommendation-ranking.ts`)

- Ranked statuses: open + accepted (`RANKED_STATUSES`). Computed on every read; never stored.
- `RANKING_WEIGHTS`: stored priority score contributes up to **50**; confidence HIGH +10 / MEDIUM +4 / LOW -10; goal match +10; closing within 3 days +15, within 7 days +8; waiting >= 14 days without a decision -5; channel publishable +8, connect-to-publish +2; blocked -25; no current evidence -20; corroborated +4; accepted +5; per similar accepted +6 (up to 2), per similar rejected -8 (up to 3), per similar skipped -3 (up to 3); each deferral beyond the first -5; history window 90 days.
- Bands (`BANDS`): **now** at score >= 70 *and* current evidence, at least medium confidence and nothing blocking (otherwise held back to **next** with the reason); **next** >= 40; **later** below; **hidden** while snoozed.
- Tie-breaks (`compareRanked`): closing sooner, higher confidence, more current evidence, created earlier, id.
- Each result carries `rank`, `score`, `band`, `factors`, an `explanation` (top three factors), `heldBack` and `resurfaced` ("Back after you deferred it").
- **Not now** (`snoozeRecommendation`, `SNOOZE_LIMITS`): 1-30 days, default 7; refused (409) if the recommendation is not ranked or would stop being relevant while hidden. Increments `snoozeCount` and writes a `defer` event.

### 3.7 Aura Suggests view (`lib/aura-suggests.ts`)

`toSuggestion` turns a recommendation + ranking into a `SuggestionView`: what, why (`plainWhy` strips engine bookkeeping), expected outcome, "Based on" sources (`EVIDENCE_SOURCE_LABEL`, e.g. `TREND_ITEM` -> "Trend signal", `ANALYTICS_REPORT` -> "Recent content performance", `MEMORY_INSIGHT` -> "What has worked for you before"; business-profile fields -> "Business goals", "Your audience", ...), timing in days, blockers as what to do (`plainBlocker`), and one next step from the module routing. `TECHNICAL_TOKENS` / `readableText` guard that no enum names, scores or ids reach the person. `getSuggestions` returns `suggestions` (open, best first, default limit 20), `accepted` (said yes, not started) and `heldBack`.

When cards are shown, the client posts their ids to `POST /api/recommendations/presented`; each never-shown one moves `GENERATED` -> `PRESENTED` with the surface and rank in its event metadata (idempotent; up to 100 ids per call).

### 3.8 Module routing and creation

- `routeRecommendation` (`lib/aura-modules.ts`) picks the primary module by the engine's action (`ROUTE_BY_ACTION`, e.g. `post` -> Content Studio "Create content"; `series` -> Campaigns "Plan the series"; `connect-channel` -> Connectors "Connect"; `apply-pattern` -> Content Plan "Add to your plan"), falling back to `ROUTE_BY_TYPE`. There are ten modules (`AURA_MODULE_IDS`): content-studio, campaigns, outreach, analytics, memory, competitors, lead-discovery, content-plan, connectors, business-profile. Content Studio, Campaigns and Outreach take a `prefill` hand-off; the rest open with the context bar (`context`). Every destination carries `?rec=<id>`.
- `creationPlan` (`lib/recommendation-creation.ts`) gives one answer to "what does Create mean here": kind `content` / `workflow` / `action` (`CREATION_KIND`) and state `ready`, `accept_first`, `needs_info`, `not_creatable` or `closed`.
- `startCreation` accepts an open suggestion on the way ("Said yes by creating from it in <module>"), or refuses with 409 and the plain reason. `recordCreation` (called from content generation, campaign orchestration, outreach and the job runner) links what was made (`link` event) and moves an accepted recommendation to `IN_PROGRESS`.
- The **Context Handoff** (`buildContextHandoff`, `CONTEXT_HANDOFF_VERSION = 1`) carries `recommendationId`, `opportunityId`, business, goal, audience, channel, action, reason, evidence, expectedOutcome, CTA, brand voice and relevant memory, each with its `source` (`recommendation`, `opportunity`, `business_profile`, `campaign`, `brand_voice`, `marketing_memory`, `content_playbook`); missing values are null and listed with `MISSING_FIELD_POLICY`. `handoffToContentRequest` turns it into a Content Studio request (brief capped at `CONTENT_BRIEF_LIMIT` = 2000 chars). `lib/creation-handoff.ts` (`CREATION_HANDOFF_VERSION = 1`) extends it to campaigns and outreach.

### 3.9 Data readiness (`lib/data-readiness.ts`)

Scenarios (`READINESS_SCENARIOS`): `business_context`, `no_channels`, `insufficient_signals`, `no_opportunities`, `low_confidence`, `no_connected_channel`, `no_performance_data`. Each is blocking or limiting; the result state is `ready`, `limited` or `blocked`, with `primary` being the first thing to fix. `getReadiness` counts business profile fields, trend keywords, tracked competitors, current non-business-context signals, active and low-confidence opportunities, analytics reports and published drafts.

### 3.10 Expiry

`expireRecommendations` runs at the start of `listRecommendations`: open recommendations whose `relevantUntil` has passed move to `EXPIRED` (source `system`). The opportunity is left alone.

### 3.11 Concurrency and idempotency

`transitionRecommendation` runs in a transaction and uses a compare-and-swap `updateMany where { id, status }`: a concurrent change returns 409 "Someone else updated this recommendation first". `expectedStatus` refuses actions taken on a stale screen. Repeating the current status is a no-op. Accepting removes the low-confidence blocker; nothing with blockers can be started or completed.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/suggestions/page.tsx` | Aura Suggests page, empty states, held-back list |
| Page | `app/dashboard/suggestions/history/page.tsx` | Suggestion history, outcome filter, learning patterns |
| Component | `components/dashboard/suggestions/aura-suggests.tsx` | Suggestion cards; decide, edit, skip, not now, next step; reports "presented" |
| Component | `components/dashboard/suggestions/readiness-panel.tsx` | What Aura needs before it can recommend |
| Component | `components/dashboard/suggestions/suggest-actions.tsx` | "Get Aura's suggestions" / detect opportunities button |
| Component | `components/dashboard/recommendations/recommendation-context-bar.tsx` | Context bar on any module page with `?rec=` |
| Component | `components/dashboard/recommendations/creation-context-panel.tsx` | Recommendation context on campaign / outreach pages |
| API | `app/api/recommendations/**/route.ts` | 16 route handlers (see section 6) |
| Service | `server/recommendations/recommendation.service.ts` | Hand-off, create from opportunity, transitions, decide, present, edit, expire, get, history, list |
| Service | `server/recommendations/engine.service.ts` | `generateRecommendation` engine run + audit |
| Service | `server/recommendations/autosuggest.service.ts` | `suggestFromOpportunities`, `openOpportunitiesWithoutSuggestion` |
| Service | `server/recommendations/ranking.service.ts` | `surfaceRecommendations`, `snoozeRecommendation`, `SNOOZE_LIMITS` |
| Service | `server/recommendations/suggestions.service.ts` | `getSuggestions` (ranked + quality-gated views) |
| Service | `server/recommendations/quality.service.ts` | `getRecommendationQuality`, `qualityFor` |
| Service | `server/recommendations/readiness.service.ts` | `getReadiness` |
| Service | `server/recommendations/history.service.ts` | `listRecommendationHistory`, `repeatHolds` |
| Service | `server/recommendations/context.service.ts` | `getRecommendationContext`, `ownRecommendation`, `linkRecommendation`, `getRecommendationHandoff` |
| Service | `server/recommendations/context-handoff.service.ts` | `getContextHandoff` |
| Service | `server/recommendations/creation.service.ts` | `getCreation`, `startCreation`, `recordCreation` |
| Lib | `lib/recommendations.ts` | Vocabulary, lifecycle, sync, edits, schema, default draft, execution brief |
| Lib | `lib/recommendation-handoff.ts` | Opportunity hand-off + eligibility |
| Lib | `lib/recommendation-engine.ts` | Action catalogue, selection, template/model writing, assessment, support gate |
| Lib | `lib/recommendation-rules.ts` | Guardrails as data |
| Lib | `lib/recommendation-ranking.ts` | Weights, bands, tie-breaks, ranking |
| Lib | `lib/recommendation-quality.ts` | Eight quality checks + verdict |
| Lib | `lib/recommendation-history.ts` | History entries, repeat holds, learning candidates |
| Lib | `lib/recommendation-context.ts` | Recommendation as it travels between modules |
| Lib | `lib/recommendation-context-handoff.ts` | Context Handoff v1 contract |
| Lib | `lib/recommendation-creation.ts` | Creation plan, provenance |
| Lib | `lib/creation-handoff.ts` | Campaign and outreach creation hand-offs |
| Lib | `lib/aura-suggests.ts` | Plain-language suggestion view |
| Lib | `lib/aura-modules.ts` | Module catalogue, routing, module hand-offs |
| Lib | `lib/data-readiness.ts` | Readiness scenarios, `mayWriteRecommendations` |
| Tests | `tests/recommendations.test.ts`, `tests/recommendation-*.test.ts`, `tests/aura-suggests.test.ts`, `tests/aura-modules.test.ts`, `tests/data-readiness.test.ts`, `tests/creation-handoff.test.ts`, `tests/creation-handoff-server.test.ts` | Unit tests (see section 10) |

## 5. Data model

All in `prisma/schema.prisma`.

### `Recommendation`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | String (cuid) | |
| `companyId` | String | Workspace; cascade delete with `Company` |
| `opportunityId` | String | Required; `onDelete: NoAction` (an opportunity with recommendations cannot be deleted on its own) |
| `type` | `RecommendationType` | |
| `status` | `RecommendationStatus` | default `GENERATED` |
| `title`, `summary`, `action`, `steps[]`, `rationale`, `expectedOutcome`, `outcomeMetric?` | | What / action / why / outcome |
| `channel?`, `contentType?`, `audience?` | String | |
| `details` | Json | Type-specific detail; `details.action` (engine action id), `details.competitor`, `details.engine` (bookkeeping) |
| `executable`, `blockers[]`, `flags[]` | Boolean, String[] | Guardrail results |
| `snoozedUntil?`, `snoozeCount` | DateTime, Int | "Not now" |
| `confidence`, `confidenceReason?` | `OpportunityConfidence`, String | |
| `priority`, `priorityScore` | `OpportunityPriority`, Int | |
| `relevantUntil?` | DateTime | |
| `handoff`, `handoffVersion` | Json, Int | The opportunity hand-off it was built from |
| `contextRevision?`, `contextFingerprint?`, `contextFields[]` | | Business Context it was built against |
| `createdBy` | String | `user:<id>`, `rec-engine-v1:template`, `rec-engine-v1:ai:<model>` |
| `statusChangedAt`, `presentedAt?`, `decidedAt?`, `decidedById?`, `decisionNote?`, `editedAt?`, `startedAt?`, `completedAt?`, `expiredAt?`, `createdAt`, `updatedAt` | | Lifecycle timestamps |

Indexes: `[companyId, status]`, `[companyId, relevantUntil]`, `[opportunityId]`.

### `RecommendationEvent`

Append-only history: `fromStatus?`, `toStatus`, `action` (default `"status"`), `source` (default `"user"`), `actorId?`, `note?`, `metadata` (edit diffs, where presented and at what rank, deferral, creation link, quality failure), `createdAt`. Index `[recommendationId, createdAt]`; cascade on recommendation delete.

### `RecommendationEvidence`

Evidence copied from the opportunity: `opportunitySignalId?`, `signalId?` (both `SetNull`), `kind` (`OpportunitySignalKind`), `refId?`, `label`, `detail`, `url?`, `observedAt?`, `reliability?`. Indexes on `recommendationId` and `signalId`.

### Enums

- `RecommendationStatus`: as in 3.1.
- `RecommendationType`: as in 3.1.
- Uses `OpportunityConfidence` (`LOW`, `MEDIUM`, `HIGH`) and `OpportunityPriority` from the Opportunity model.

Also read: `Opportunity` (status sync), `OpportunitySignal`, `Signal`, `CompanyTrendConfig`, `CompetitorProfile`, `AnalyticsReport`, `ContentDraft`, `User` (actor names), `AuditLog` (via `recordAudit`).

## 6. API endpoints

All routes call `requireActiveCompany()` and scope every query to the active workspace. Full catalogue: [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
| --- | --- | --- | --- |
| GET | `/api/recommendations?status=&opportunityId=&limit=` | List (newest first, default 50, max 200); expires stale ones first | Any member |
| GET | `/api/recommendations/surface?includeHidden=1` | Ranked list with score, band, factors, explanation | Any member |
| POST | `/api/recommendations/generate` | Run auto-suggest over open opportunities (`maxDuration` 60 s) | `company:update` |
| POST | `/api/recommendations/presented` | Record shown ids (`ids` 1-100, `surface?`, `positions?`) | `content:create` (others get `recorded: false`) |
| GET | `/api/recommendations/readiness` | Data readiness | Any member |
| GET | `/api/recommendations/history?outcome=&limit=` | Past suggestions, counts, learning (limit default 100, max 200) | Any member |
| GET | `/api/recommendations/:id` | One recommendation with evidence, events, opportunity, `execution` brief | Any member |
| PATCH | `/api/recommendations/:id` | Edit (`changes` of `EDITABLE_FIELDS`, `note?`, `expectedStatus?`) -> `EDITED` | `company:update` |
| POST | `/api/recommendations/:id/decision` | `ACCEPTED` / `SKIPPED` / `REJECTED` / `WITHDRAWN` | `company:update` |
| POST | `/api/recommendations/:id/status` | Any user-settable status | `company:update` |
| POST | `/api/recommendations/:id/snooze` | Not now (`days` 1-30, default 7) | `company:update` |
| GET | `/api/recommendations/:id/history` | Full event history with actor names and outcome | Any member |
| GET | `/api/recommendations/:id/quality` | Quality report | Any member |
| GET | `/api/recommendations/:id/context` | Context for the context bar | Any member |
| GET | `/api/recommendations/:id/handoff` | Context Handoff v1 + Content Studio request | Any member |
| GET | `/api/recommendations/:id/brief?type=&platform=` | Content Brief, validation, content request (built by `server/content/content-brief.service.ts`) | Any member |
| GET | `/api/recommendations/:id/creation?module=` | Creation plan, provenance, content request | Any member |
| POST | `/api/recommendations/:id/creation` | Start creation (`module?`); accepts open suggestions | `content:create`; plus `company:update` when it accepts |

Related entry points owned by other features: `POST /api/opportunities/:id/recommendations` (person asks for a recommendation, `company:update`), `POST /api/opportunities/detect` (runs auto-suggest afterwards).

Errors: 404 "Recommendation not found" for another workspace's id; 409 for illegal or stale transitions, a live recommendation already in play, blocked start/complete, or an invalid snooze; 400 for validation errors.

## 7. External services

The only external call is the optional model rewrite in the engine, through `server/ai/claude.ts` (`completeStructured`, tier `standard`). It uses Anthropic when `ANTHROPIC_API_KEY` is set, otherwise Gemini when `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` is set (`isClaudeConfigured`); with neither, every recommendation is written from templates. See [23-ai-layer](../23-ai-layer/01-FEATURE-DETAILS.md) and [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

No dedicated cron. Work happens on request:

- Auto-suggest runs inside `POST /api/opportunities/detect` and `POST /api/recommendations/generate`.
- Expiry runs lazily inside `listRecommendations`.
- `server/jobs/runners.ts` calls `recordCreation` when a planner job was started for a recommendation, so the plan is linked and the recommendation moves to `IN_PROGRESS`.

## 9. Security & permissions

- **Workspace scoping.** Every query filters by `companyId` (directly, or via the recommendation / opportunity); ids from requests are never used on their own. `tests/recommendation-security.test.ts` checks this statically across the codebase; `scripts/verify-recommendation-security.ts` proves it over HTTP.
- **RBAC.** Decisions, edits, status changes, snooze and generate need `company:update` (OWNER, ADMIN). Creation needs `content:create`; creating from an open suggestion also needs `company:update`. Viewers are read-only, and their views are not recorded as "presented".
- **Validation.** Zod schemas on every body/query (status enum, `USER_SETTABLE_STATUSES`, `EDITABLE_FIELDS` with `.strict()`, note <= 2000 chars, ids <= 64 chars, max 100 ids).
- **Integrity.** The model can change only wording; validated against evidence and business facts. Evidence is copied, so a recommendation keeps what it was based on.
- **Audit.** Every engine run is recorded as `RECOMMENDATION_GENERATED`.

## 10. Testing

Unit tests (Vitest, `tests/`):

- `recommendations.test.ts`, `recommendation-lifecycle.test.ts`: vocabulary, transitions, sync, edits, outcomes.
- `recommendation-handoff.test.ts`: opportunity hand-off and eligibility.
- `recommendation-engine.test.ts`, `recommendation-rules.test.ts`: selection, validation, support gate, guardrails.
- `recommendation-ranking.test.ts`: weights, bands, tie-breaks.
- `recommendation-quality.test.ts`: the eight checks.
- `recommendation-history.test.ts`: outcomes, repeat holds, learning candidates.
- `recommendation-context-handoff.test.ts`, `recommendation-creation.test.ts`, `creation-handoff.test.ts`, `creation-handoff-server.test.ts`.
- `aura-suggests.test.ts`, `aura-modules.test.ts`, `data-readiness.test.ts`.
- `recommendation-security.test.ts`: static workspace-scoping check.

Verification scripts (`pnpm verify:*`, against a real database or the running app): `verify:recommendation-handoff`, `verify:recommendations`, `verify:engine`, `verify:guardrails`, `verify:prioritization`, `verify:lifecycle`, `verify:suggestions`, `verify:modules`, `verify:context-handoff`, `verify:autosuggest`, `verify:history`, `verify:quality`, `verify:readiness`, `verify:recommendation-security`, `verify:creation`, and the end-to-end `verify:sprint8`.

## 11. Configuration & limits

| Setting | Value | Source |
| --- | --- | --- |
| Engine version | `rec-engine-v1` | `ENGINE_VERSION` |
| New recommendations per workspace | 10 per rolling 24 h | `FREQUENCY_LIMITS.perDay` |
| Waiting for a decision | 15 | `FREQUENCY_LIMITS.maxOpen` |
| Per channel | 5 per rolling 7 days | `FREQUENCY_LIMITS.perChannelPerWeek` |
| Duplicate window / rejected window / similarity | 14 days / 30 days / 0.6 | `DUPLICATE_RULES` |
| Mute | 3 rejections in 30 days | `DUPLICATE_RULES` |
| Max relevance | 30 days from creation | `EXPIRY_RULES.maxProposedDays` |
| Snooze | 1-30 days, default 7 | `SNOOZE_LIMITS` |
| Ranking bands | now >= 70, next >= 40 | `BANDS` |
| Ranking history window | 90 days | `RANKING_WEIGHTS.historyDays` |
| Repeat hold | skipped 14 d, withdrawn 14 d, rejected 30 d | `REPEAT_HOLD_DAYS` |
| Auto-suggest per run | 5 opportunities, 40 s budget (25 s after detection) | `suggestFromOpportunities` |
| Suggestions shown | 20 per list | `getSuggestions` |
| Learning patterns | >= 4 answers; confidence MEDIUM at 7, HIGH at 12 | `LEARNING_MIN_SAMPLE`, `confidenceFor` |
| Model call | tier `standard`, effort `medium`, 2000 max tokens | `defaultWrite` |
| Content brief from handoff | 2000 chars | `CONTENT_BRIEF_LIMIT` |
| Env vars | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` (optional) | `server/ai/claude.ts` |

## 12. Known limitations & future work

- Ranking is recomputed on every read; there is no stored ranking or cache.
- Expiry is lazy (on list); no scheduled job expires recommendations.
- `CHANNEL` recommendations can only target LinkedIn and Instagram today: X, YouTube and WordPress connectors are `coming_soon`, and Newsletter has no publishing integration.
- Learning candidates from history are shaped as Marketing Memory insights but are "ready to feed it, not yet written to it" (`lib/recommendation-history.ts`).
- Execution states beyond `IN_PROGRESS` are left to the execution sprints (comment in `lib/recommendations.ts`).
- Auto-suggest is bounded per run (5 opportunities / 40 s); larger backlogs need several runs.

## 13. Related documents

- [RECOMMENDATION-MODEL.md](../../../RECOMMENDATION-MODEL.md), [RECOMMENDATION-ENGINE.md](../../../RECOMMENDATION-ENGINE.md), [RECOMMENDATION-RULES.md](../../../RECOMMENDATION-RULES.md), [RECOMMENDATION-PRIORITIZATION.md](../../../RECOMMENDATION-PRIORITIZATION.md), [RECOMMENDATION-LIFECYCLE.md](../../../RECOMMENDATION-LIFECYCLE.md), [RECOMMENDATION-QUALITY.md](../../../RECOMMENDATION-QUALITY.md), [RECOMMENDATION-HISTORY.md](../../../RECOMMENDATION-HISTORY.md), [RECOMMENDATION-CONTEXT-HANDOFF.md](../../../RECOMMENDATION-CONTEXT-HANDOFF.md), [RECOMMENDATION-CREATION.md](../../../RECOMMENDATION-CREATION.md), [OPPORTUNITY-RECOMMENDATION.md](../../../OPPORTUNITY-RECOMMENDATION.md)
- [AURA-SUGGESTS.md](../../../AURA-SUGGESTS.md), [AURA-MODULES.md](../../../AURA-MODULES.md), [CAMPAIGN-OUTREACH-CREATION.md](../../../CAMPAIGN-OUTREACH-CREATION.md), [EMPTY-STATES.md](../../../EMPTY-STATES.md), [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md), [SPRINT-8-TEST-REPORT.md](../../../SPRINT-8-TEST-REPORT.md)
- Sibling features: [10-aura-home-and-briefing](../10-aura-home-and-briefing/01-FEATURE-DETAILS.md), [14-campaigns-and-content-planner](../14-campaigns-and-content-planner/01-FEATURE-DETAILS.md), [18-marketing-memory-and-analytics](../18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md), [23-ai-layer](../23-ai-layer/01-FEATURE-DETAILS.md)
- Architecture: [02-ARCHITECTURE.md](02-ARCHITECTURE.md)
