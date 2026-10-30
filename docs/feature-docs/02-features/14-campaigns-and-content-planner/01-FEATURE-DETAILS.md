# Campaigns & Content Planner

> Two planning tools that turn a stated goal into scheduled, reviewable marketing work. **Campaigns** (the Campaign Orchestrator) take one goal, a duration and a set of modules, ask the AI for a day-by-day plan and materialise it as `CampaignTask` rows that a daily job later runs through the existing content, outreach and lead-discovery pipelines; every output lands as a draft in the normal approval queues. The **Content Planner** ("Content plan") takes an explicit monthly brief (business goals, campaign objectives, topics, brand guidelines, channels, cadence) and produces a dated monthly content calendar whose items can each be drafted in Content Studio with one click. Both exist so a founder can plan a month of marketing in one step without giving up per-item human approval.

## 1. Overview

| Part | What it produces | Where it is stored | How it runs |
|---|---|---|---|
| Campaign Orchestrator | An AI (or deterministic) day-by-day plan plus a task schedule (`GENERATE_CONTENT`, `RUN_OUTREACH_BATCH`, `RUN_DISCOVERY`, `REVIEW_CHECKPOINT`) | `Campaign` + `CampaignTask` | Created synchronously by `POST /api/campaigns/orchestrate`; tasks executed by `executeDueCampaignTasks` behind `/api/cron/campaigns` |
| Content Planner | A monthly calendar: summary, weekly themes, dated items (channel, content type, title, hook, brief, CTA, hashtags, objective) | `MarketingPlan` (one per company per month) | Queued as a `MARKETING_PLAN` generation job (`/api/jobs`), or synchronously via `POST /api/planner` |

Both can be started from an Aura recommendation (`?rec=<id>`) through the creation handoff (`lib/creation-handoff.ts`, `server/recommendations/creation.service.ts`). Campaigns planned that way are held by the execution gate (`lib/execution-gate.ts`): they are saved as `DRAFT` plans and never executed while `CONTEXTUAL_EXECUTION_ENABLED = false`.

Non-negotiable carried through the code: the orchestrator and the planner never publish or send anything. Executor output is always a `ContentDraft` / `OutreachMessage` draft awaiting the usual approval.

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
|---|---|---|---|
| Campaigns list | `/dashboard/campaigns` (`app/dashboard/campaigns/page.tsx`) | See non-archived campaigns with a derived state badge (Needs review, Behind, Running, Paused, Finished, Planned / Not started) and the action or summary line; open a campaign; jump to "Campaign ideas" (`/dashboard/advisor`); "New campaign" button | Any member can view; "New campaign" shown only with `content:approve` (OWNER, ADMIN per `lib/rbac.ts`) |
| Plan a campaign | `/dashboard/campaigns/new` (`app/dashboard/campaigns/new/page.tsx`, `components/dashboard/campaigns/campaign-form.tsx`) | Enter name, goal, duration (days), target audience, themes and modules (Content posts, Outreach, Lead discovery, Engagement). With `?rec=<id>`, the form is pre-filled from the recommendation, a `CreationContextPanel` shows what is carried and what is missing, and the execution-gate message explains the campaign is saved as a plan | Submit requires `content:approve` (checked by the API); accepting an open recommendation on create requires `company:update` (OWNER/ADMIN) |
| Campaign detail | `/dashboard/campaigns/[id]` (`app/dashboard/campaigns/[id]/page.tsx`) | See state, progress percentage (done / total tasks), the plan overview, task mix by type, the "next task" to look at, the creation context if planned from a suggestion, and the full timeline (`CampaignTimeline`) with per-task status, approval state from the linked draft, and weekly checkpoint summaries. Pause / resume via `PauseButton` (hidden for `COMPLETED` / `ARCHIVED`); held campaigns show a "Waiting for execution" badge instead | View: any member. Pause/resume: `content:approve` |
| Content plan | `/dashboard/planner` (`app/dashboard/planner/page.tsx`, `components/dashboard/planner/planner-view.tsx`) | Fill the brief (month `YYYY-MM`, business goals, campaign objectives, topics, brand guidelines, audience, channels, posts per week); generate; watch job progress; view the calendar grouped by week with themes, grounding sources and an outline notice when parts fell back; switch between saved months (`?month=YYYY-MM`, last 12); click "Draft this" on any item to open `/dashboard/content/new?type=…&brief=…`. With `?rec=<id>`, the brief is pre-filled via `planBriefFrom` | View: any member. Generate: `content:create` (OWNER, ADMIN, MEMBER) |

Planner convenience behaviour:
- First-plan defaults come from the workspace profile (`getWorkspaceProfile` → `marketing.audience`, `marketing.goals`, `marketing.channels`).
- The in-progress brief is kept in `localStorage` under `aura.planner.brief` and cleared when a run succeeds.
- The page reattaches to a running `MARKETING_PLAN` job after reload; the client gives up after 2 minutes (`giveUpAfterMs`), matching the server's stuck-job fuse.
- Client-side checks before queueing: business goals at least 10 characters, objectives at least 5, at least one channel.

## 3. How it works

### 3.1 Creating an orchestrated campaign

1. `POST /api/campaigns/orchestrate` resolves the active company (`requireActiveCompany`), checks `content:approve`, then `requireEntitlement(companyId, 'campaigns')`.
2. Body is validated with `createCampaignSchema` (`lib/validations/campaign.ts`): `name` 2–120 chars, `goal` 4–2000, `durationDays` integer 3–60 (default 30), `modules` `{content (default true), outreach, engagement, discovery}`, `targetAudience` up to 1000, `themes` up to 20 items of 1–80 chars, optional `recommendationId`.
3. If `recommendationId` is present, `getCreation(companyId, id, 'campaigns')` is called. If `plan.canCreate` is false the route returns **409** with the message and a `fix` link. If `plan.acceptsOnCreate` is true (an open suggestion), the caller must have `company:update`, and `startCreation` accepts it. `campaignCreationHandoff` then builds the `CreationContext`.
4. `createCampaign` (`server/campaigns/campaign.service.ts`):
   - calls `generateCampaignPlan` (see 3.2);
   - computes the execution gate: `executionGate('campaign', Boolean(creation))`;
   - start date = today 00:00 UTC, end date = start + `durationDays`;
   - in one transaction creates the `Campaign` with status `DRAFT` if gated, else `ACTIVE`, storing `plan`, `modulesIncluded`, `themes`, `targetAudience`, and (if from a recommendation) `recommendationId` + `creationContext`;
   - materialises tasks: for each plan day, a `GENERATE_CONTENT` task when `contentType` is set (with `topic`, `rationale`), a `RUN_OUTREACH_BATCH` task when `outreach`, a `RUN_DISCOVERY` task when `discovery`; scheduled at start + (day − 1);
   - adds a `REVIEW_CHECKPOINT` every 7 days (day 7, 14, …) up to `durationDays`;
   - records audits `CAMPAIGN_CREATED` (with `recommendationId` and `executionHeld` when relevant) and `CAMPAIGN_PLAN_GENERATED` (`taskCount`, `model`).
5. For a recommendation, `recordCreation` links the campaign into the recommendation history (`type: 'campaign'`).
6. Response **201**: `{ id, name, status, execution: { blocked, message? } }`.

### 3.2 Campaign planning (`server/campaigns/planner.ts`)

- If no AI provider is configured (`isClaudeConfigured()` false), `deterministicPlan` is used and `model = 'none'`.
- Otherwise one structured call: `completeStructured({ schema: campaignPlanSchema, maxTokens: 4000, effort: 'high' })`. The system prompt combines `brandContextToPrompt` (voice and writing rules excluded), `brandVoiceToPrompt`, and active marketing memories (`getActiveMemories` → `memoriesToPrompt`), and instructs "2–4 posts/week is healthy", "only use enabled modules". The prompt carries goal, duration, enabled modules, audience (campaign field, else the workspace `brand.audience.stated`), themes, and — when from a recommendation — `creationContextPrompt(context)`.
- `campaignPlanSchema`: `overview` 1–1200 chars, `days` 1–60 entries; each day `day` 1–60, `contentType` one of `CONTENT_TYPES` or null, `topic` ≤300, `outreach`, `discovery`, `rationale` ≤400.
- `gatePlan` drops days outside 1..`durationDays` and clears any action for a module not enabled.
- Any AI failure falls back to `deterministicPlan` (logged as a warning).
- `deterministicPlan`: content on days-of-week 1, 3, 5 of each 7-day block (`CAROUSEL` when `day % 6 === 0`, else `LINKEDIN_POST`), topic `"<theme> — angle <week>"`, themes cycled (default `"your key message"`); outreach on day-of-week 2; discovery on day-of-week 4 while `day <= 21`.

The `engagement` module is accepted and stored but the planner never schedules engagement work; the form describes it as "Handled live in the extension (no schedule)".

### 3.3 Executing tasks (`server/campaigns/executor.service.ts`)

`executeDueCampaignTasks(now)` is the daily conductor:

1. Loads up to `MAX_TASKS_PER_RUN = 100` tasks with status `PENDING`, `scheduledDate <= now`, on `ACTIVE` campaigns, oldest first.
2. Skips (leaves untouched) any task whose campaign has a `creationContext` while the execution gate is closed — even if something set it `ACTIVE`.
3. Acting user = the company's `OWNER` member (else any member), cached per company per run.
4. Per task type:
   - `GENERATE_CONTENT` → `generateDraft({ source: { kind: 'BRIEF', brief: topic ?? goal ?? name }, campaignId })`; task → `GENERATED`, `relatedContentDraftId` set. No `contentType` → `SKIPPED`.
   - `RUN_DISCOVERY` → oldest active `DiscoveryProfile`; `runDiscovery`; `relatedDiscoveryRunId` set. No profile → `SKIPPED`.
   - `RUN_OUTREACH_BATCH` → up to `OUTREACH_BATCH_SIZE = 3` leads with status `NEW`/`QUALIFIED` and no messages, ordered by `fitScore` desc then `createdAt` desc; `draftForLead` for each (individual failures logged, not fatal). No leads → `SKIPPED`.
   - `REVIEW_CHECKPOINT` → week number = max(1, round((scheduledDate − startDate) / 7 days)); `generateCheckpointSummary` stored in `checkpointSummary`; audit `CAMPAIGN_CHECKPOINT_GENERATED`.
5. Successful tasks record `CAMPAIGN_TASK_GENERATED`. A thrown error marks the task `FAILED` with `error` (first 500 chars) and records `CAMPAIGN_TASK_FAILED`; other tasks continue.
6. `closeFinishedCampaigns`: every `ACTIVE` campaign with at least one task and no `PENDING` task becomes `COMPLETED` (`endDate = now`), audit `CAMPAIGN_COMPLETED`. Tasks awaiting review do not hold a campaign open.
7. Returns `{ processed, generated, skipped, failed, completed }`.

Approval sync: when a linked content draft is approved or published, `syncCampaignTask` (`server/approval/approval.service.ts`) moves `GENERATED` tasks to `APPROVED`; if the draft leaves those states, `APPROVED` tasks go back to `GENERATED`.

### 3.4 Weekly checkpoint (`server/campaigns/checkpoint.service.ts`)

Counts real progress (tasks `GENERATED`, tasks `APPROVED`, drafts `PUBLISHED`, total drafts for the campaign) into a facts string. Without AI, returns a fixed template. With AI, `complete({ maxTokens: 300, effort: 'low', tier: 'cheap' })` writes a 3–4 sentence update "using ONLY the facts provided"; on error it falls back to the facts.

### 3.5 Pause / resume

`POST /api/campaigns/:id/status` with `{ action: 'pause' | 'resume' }` (`content:approve`). `setCampaignStatus` scopes by company (404 `CampaignNotFoundError`), refuses with **409** `execution_not_available` for gated (recommendation-planned) campaigns, sets `PAUSED` or `ACTIVE`, and audits `CAMPAIGN_PAUSED` / `CAMPAIGN_RESUMED`.

### 3.6 Derived campaign state (`lib/campaign-status.ts`)

The UI never shows the raw enum. `countTasks` buckets tasks into `awaitingReview` (GENERATED), `overdue` (PENDING, due), `scheduled` (PENDING, future), `done` (GENERATED + APPROVED + SKIPPED), `failed`. `deriveCampaignState(status, counts, { executionHeld })` resolves, in order:

| Condition | Key | Label |
|---|---|---|
| `ARCHIVED` | ARCHIVED | Archived |
| `PAUSED` | PAUSED | Paused |
| `COMPLETED`, or `ACTIVE` with all tasks terminal, and items awaiting review | NEEDS_REVIEW | Needs review |
| same, nothing awaiting review | FINISHED | Finished |
| `DRAFT` + execution held | NOT_STARTED | Planned |
| `DRAFT` | NOT_STARTED | Not started |
| `ACTIVE` with awaiting review | NEEDS_REVIEW | Needs review |
| `ACTIVE` with overdue tasks | BEHIND | Behind |
| otherwise | RUNNING | Running |

`taskState` labels tasks (Needs review, Approved, Skipped, Failed, Due, Scheduled) and `taskTypeLabel` names task types (e.g. `REVIEW_CHECKPOINT` → "Weekly review").

### 3.7 Generating a monthly content plan

1. The planner page queues a `MARKETING_PLAN` job (`useGenerationJob` → `/api/jobs`, which requires `content:create`). If the plan comes from an open recommendation, the client first calls `POST /api/recommendations/:id/creation` with `{ module: 'content-plan' }` to accept it.
2. The runner (`server/jobs/runners.ts`) re-validates `job.inputs` with `planInputsSchema` and calls `generateMarketingPlan`. Afterwards, for a `recommendationId` that `canCreate` and does not `acceptsOnCreate`, it calls `recordCreation` (`type: 'content-plan'`, id = the month).
3. `planInputsSchema` (`lib/validations/planner.ts`): `month` `YYYY-MM`; `businessGoals` 10–1500; `campaignObjectives` 5–1500; `topics` up to 30 (deduplicated, 1–80 chars); `brandGuidelines` ≤2000; `audience` ≤400; `channels` 1–6 of `LinkedIn, Blog, Newsletter, X, Instagram, YouTube`; `postsPerWeek` 1–14; optional `campaignId`, `recommendationId`.
4. `buildSchedule(month, postsPerWeek)` computes real slots: weekdays only, grouped into 7-day blocks of the month, up to `postsPerWeek` per block, spread evenly (`step = days / take`). No weekdays → `PlannerError` (400).
5. Context loaded in parallel: company, `getBrandContext`, the latest `TrendDigest` (up to 8 titles), and `retrieve()` from the knowledge base (limit 6; failure is non-fatal). `groundedOn` lists which of brand voice, trend topics and knowledge base were used.
6. Without an AI provider: `outlineCalendar` fills every slot from the brief (`model = 'none'`).
7. With AI: `draftCalendar` (`server/planner/calendar-draft.ts`) runs against a deadline of start + `DRAFT_BUDGET_MS` (45 000 ms):
   - **Strategy** call (summary + weekly themes): `maxTokens 1500`, `effort 'low'`, capped at `STRATEGY_BUDGET_MS` (15 000 ms).
   - **Weeks** drafted concurrently (`Promise.all`), each `maxTokens min(6000, 800 + 500 × slots)`, `effort 'medium'`.
   - A call is not started with less than `MIN_ATTEMPT_MS` (5 000 ms) left; a schema slip is retried once with the errors echoed back; non-retryable errors are not retried. Model calls use `complete({ json: true, maxAttempts: 1 })`.
   - Channels rotate through the chosen list (`assignChannels`); the model must use the given dates.
   - Any strategy or week not delivered in time is filled from the outline, and recorded in `payload.outline` (`weeks`, `slots`, `strategy`).
   - `model` is the configured model if anything came from the model, otherwise `'outline'`.
8. Saved with `marketingPlan.upsert` on `(companyId, month)` — regenerating a month replaces it — and audited as `MARKETING_PLAN_GENERATED`.
9. Progress messages go to the job (`Reading your brief…` 8 %, … `Saving your calendar…` 92 %). The server treats a `MARKETING_PLAN` job as stuck after 2 minutes (`STUCK_AFTER_MS_BY_KIND`).

Plan item schema (`planItemSchema`): `date`, `week` 1–6, `channel`, `contentType` (`LINKEDIN_POST`, `CAROUSEL`, `TWEET_THREAD`, `BLOG`), `theme`, `title`, `hook`, `brief` ≤1200, `cta`, `hashtags` ≤8, `objective`. Payload max: 6 weeks, 60 items.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | `app/dashboard/campaigns/page.tsx` | Campaign list with derived state |
| Page | `app/dashboard/campaigns/new/page.tsx` | Plan a campaign; `?rec=` handoff, context panel, gate message |
| Page | `app/dashboard/campaigns/[id]/page.tsx` | Campaign detail, progress, next task, timeline, approval state per task |
| Page | `app/dashboard/planner/page.tsx` | Content plan page; month switcher, defaults, `?rec=` prefill |
| Component | `components/dashboard/campaigns/campaign-form.tsx` | Campaign form; posts to `/api/campaigns/orchestrate` |
| Component | `components/dashboard/campaigns/campaign-timeline.tsx` | Task timeline with status, approval and checkpoint summaries |
| Component | `components/dashboard/campaigns/pause-button.tsx` | Pause/resume; hidden for COMPLETED/ARCHIVED |
| Component | `components/dashboard/planner/planner-view.tsx` | Brief form, job start/reattach, calendar, "Draft this" links |
| Component | `components/dashboard/recommendations/creation-context-panel.tsx` | Shows carried recommendation context (shared with feature 09) |
| API | `app/api/campaigns/route.ts` | Minimal list/create (used to tag Content Studio drafts to a campaign) |
| API | `app/api/campaigns/orchestrate/route.ts` | Create an orchestrated campaign |
| API | `app/api/campaigns/[id]/status/route.ts` | Pause/resume |
| API | `app/api/planner/route.ts` | Synchronous monthly plan generation |
| API | `app/api/cron/campaigns/route.ts` | Daily executor endpoint (CRON_SECRET) |
| API | `app/api/jobs/route.ts` | Queues `MARKETING_PLAN` jobs (shared job system) |
| Service | `server/campaigns/campaign.service.ts` | `createCampaign`, `listCampaigns`, `getCampaign`, `setCampaignStatus` |
| Service | `server/campaigns/planner.ts` | `generateCampaignPlan`, `gatePlan`, `deterministicPlan` |
| Service | `server/campaigns/executor.service.ts` | `executeDueCampaignTasks`, `closeFinishedCampaigns` |
| Service | `server/campaigns/checkpoint.service.ts` | `generateCheckpointSummary` |
| Service | `server/planner/plan.service.ts` | `buildSchedule`, `generateMarketingPlan`, `listPlans`, `getPlanForMonth` |
| Service | `server/planner/calendar-draft.ts` | `draftCalendar`, `outlineCalendar`, budgets, channel rotation |
| Service | `server/jobs/runners.ts` | `MARKETING_PLAN` runner |
| Lib | `lib/campaign-status.ts` | `countTasks`, `deriveCampaignState`, `taskState`, `taskTypeLabel` |
| Lib | `lib/validations/campaign.ts` | `createCampaignSchema`, `campaignPlanSchema` |
| Lib | `lib/validations/planner.ts` | `planInputsSchema`, `planItemSchema`, `CONTENT_CHANNELS` |
| Lib | `lib/execution-gate.ts` | `executionGate`, `CONTEXTUAL_EXECUTION_ENABLED` |
| Tests | `tests/campaign-plan.test.ts` | Plan schema, `createCampaignSchema`, deterministic plan module gating |
| Tests | `tests/campaign-status.test.ts` | Task counting and derived state |
| Tests | `tests/planner-schedule.test.ts` | `buildSchedule` |
| Tests | `tests/planner-draft.test.ts` | `draftCalendar` budgets, fallbacks, stuck-job fuse |
| Tests | `tests/creation-handoff-server.test.ts` | Gated campaigns are not executed |

## 5. Data model

| Model / enum | Key fields | Notes |
|---|---|---|
| `Campaign` | `id`, `companyId`, `name`, `goal`, `status CampaignStatus` (default `DRAFT`), `startDate`, `endDate`, `durationDays` (default 30), `modulesIncluded Json`, `targetAudience`, `themes String[]`, `plan Json`, `recommendationId?`, `creationContext Json?` | Relations: `company`, `drafts ContentDraft[]`, `tasks CampaignTask[]`. Indexes `(companyId,status)`, `(companyId,recommendationId)`, `(companyId,createdAt)` |
| `CampaignTask` | `campaignId`, `companyId`, `scheduledDate`, `taskType`, `status` (default `PENDING`), `contentType?`, `topic?`, `rationale?`, `relatedContentDraftId?`, `relatedDiscoveryRunId?`, `checkpointSummary?`, `error?` | Cascade on campaign/company delete. Indexes `(companyId,scheduledDate)`, `(campaignId,scheduledDate)`, `(status,scheduledDate)` |
| `MarketingPlan` | `companyId`, `month` (first day UTC), `inputs Json`, `payload Json`, `model` (default `"none"`), `createdById?`, `generatedAt` | `@@unique([companyId, month])` |
| `CampaignStatus` | `DRAFT`, `ACTIVE`, `PAUSED`, `COMPLETED`, `ARCHIVED` | `ARCHIVED` is filtered out of lists but nothing in the code writes it |
| `CampaignTaskType` | `GENERATE_CONTENT`, `RUN_OUTREACH_BATCH`, `RUN_DISCOVERY`, `REVIEW_CHECKPOINT` | |
| `CampaignTaskStatus` | `PENDING`, `GENERATED`, `APPROVED`, `SKIPPED`, `FAILED` | `APPROVED` written only by `syncCampaignTask` |

Uses: `ContentDraft.campaignId` (drafts generated for a campaign), `DiscoveryProfile`, `Lead`, `TrendDigest`, `CompanyMember` (acting user), `GenerationJob` (planner job), audit log.

## 6. API endpoints

Full catalogue: [Internal API](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth / permission |
|---|---|---|---|
| GET | `/api/campaigns` | List non-archived campaigns (`id, name, goal, status`) | Session + active company |
| POST | `/api/campaigns` | Create a bare campaign (`name` 1–120, optional `goal` ≤1000), status default `DRAFT`, no tasks | `content:create` |
| POST | `/api/campaigns/orchestrate` | Create a planned campaign with tasks; optional `recommendationId` | `content:approve`; `campaigns` entitlement; `company:update` to accept an open recommendation |
| POST | `/api/campaigns/:id/status` | `{ action: 'pause' \| 'resume' }` | `content:approve`; 409 for gated campaigns |
| POST | `/api/planner` | Generate a month's plan synchronously (`maxDuration` 60 s) | `content:create` |
| POST | `/api/jobs` (`kind: 'MARKETING_PLAN'`) | Queue the plan as a background job (what the UI uses) | `content:create` |
| GET/POST | `/api/cron/campaigns` | Run `executeDueCampaignTasks` | `Authorization: Bearer $CRON_SECRET` |

## 7. External services

No direct third-party calls. AI calls go through the shared AI layer (`server/ai/claude.ts`: `completeStructured`, `complete`), see [23-ai-layer](../23-ai-layer/01-FEATURE-DETAILS.md). Executed tasks call internal pipelines (content generator, lead discovery, outreach drafting) which may in turn call external services. Env vars: the AI provider keys and `CRON_SECRET` — see [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

| Job | Trigger | Notes |
|---|---|---|
| Campaign executor | `GET`/`POST /api/cron/campaigns`, `maxDuration` 60 s | Route comment documents a Vercel schedule `0 9 * * *`, but `vercel.json` currently lists only `/api/cron/publish`, `/api/cron/briefing` and `/api/cron/connections` — the campaign cron must be scheduled separately for tasks to run |
| `MARKETING_PLAN` generation job | Queued from the planner page via `/api/jobs` | 45 s drafting budget inside the 60 s runner; considered stuck after 2 minutes |

## 9. Security & permissions

- Every route uses `requireActiveCompany()`; all queries are scoped by `companyId` (`getCampaign` and `setCampaignStatus` use `findFirst({ id, companyId })`, returning 404 otherwise).
- RBAC (`lib/rbac.ts`): creating/pausing orchestrated campaigns requires `content:approve`; bare campaign creation, planner generation and the job queue require `content:create`; accepting an open recommendation requires `company:update`. VIEWERs can only read.
- Plan limits: `requireEntitlement(companyId, 'campaigns')` counts campaigns in `ACTIVE`, `PAUSED` or `DRAFT` against `maxActiveCampaigns` — TRIAL 1, STARTER 2, GROWTH 10, AGENCY 100 (`server/billing/entitlements.ts`); also refuses when the trial/subscription has ended.
- All inputs validated with Zod; AI output is validated (`campaignPlanSchema`, `planItemSchema`) and module-gated before any rows are written.
- Execution gate: recommendation-planned campaigns cannot be executed, started or resumed until `CONTEXTUAL_EXECUTION_ENABLED` is flipped.
- Executor work is attributed to the company owner and every step is audited. Nothing is published or sent by this feature.
- Cron endpoint returns 401 unless `CRON_SECRET` is set and matches the bearer token.

## 10. Testing

Unit tests (`pnpm test`): `tests/campaign-plan.test.ts`, `tests/campaign-status.test.ts`, `tests/planner-schedule.test.ts`, `tests/planner-draft.test.ts`, `tests/creation-handoff-server.test.ts`; related coverage in `tests/approval.test.ts`, `tests/billing.test.ts`, `tests/tenant-isolation.test.ts`.

Verify scripts:
- `pnpm verify:planner` — speed/resilience of monthly generation against the real DB, live model if configured, and the job flow through the running app (`VERIFY_BASE_URL=http://localhost:3001`).
- `pnpm verify:creation` and `pnpm verify:sprint9` — orchestrate a campaign from a recommendation and check it is held.
- `pnpm verify:approval`, `pnpm verify:permissions`, `pnpm verify:pages` — touch campaigns/planner as part of wider checks.

## 11. Configuration & limits

| Setting | Value | Source |
|---|---|---|
| Campaign duration | 3–60 days, default 30 | `createCampaignSchema` |
| Themes | ≤20 | `createCampaignSchema` |
| Plan generation | `maxTokens` 4000, `effort` high | `planner.ts` |
| Checkpoint cadence | every 7 days | `campaign.service.ts` |
| Checkpoint summary | `maxTokens` 300, `effort` low, `tier` cheap | `checkpoint.service.ts` |
| Executor batch | 100 tasks per run | `MAX_TASKS_PER_RUN` |
| Outreach batch | 3 leads per task | `OUTREACH_BATCH_SIZE` |
| Planner cadence | 1–14 posts/week, weekdays only | `planInputsSchema`, `buildSchedule` |
| Planner channels | LinkedIn, Blog, Newsletter, X, Instagram, YouTube | `CONTENT_CHANNELS` |
| Drafting budget | 45 s total, 15 s strategy, 5 s minimum per attempt | `calendar-draft.ts` |
| Plan job stuck fuse | 2 minutes | `server/jobs/job.service.ts` |
| Plans shown | last 12 months | `listPlans` |
| Execution gate | `CONTEXTUAL_EXECUTION_ENABLED = false` | `lib/execution-gate.ts` |
| Env | `CRON_SECRET`, AI provider keys | |

## 12. Known limitations & future work

- Recommendation-planned campaigns stay `DRAFT` ("Planned") until the execution gate is turned on (documented as Sprint 10).
- A campaign created from scratch starts `ACTIVE`; a bare `DRAFT` campaign (from `POST /api/campaigns`) shows "Start the campaign", but there is no start action — `/api/campaigns/:id/status` only accepts pause/resume, and resume is the only way to set `ACTIVE`.
- `ARCHIVED` is never written by any code path; there is no delete/archive UI.
- The `engagement` module is stored but never scheduled.
- The campaign cron is not in `vercel.json`; without an external scheduler, tasks remain overdue and campaigns show "Behind".
- The planner's optional `campaignId` input is validated and stored in `inputs` but not used by `generateMarketingPlan`.
- Planner items are not turned into drafts automatically; each is drafted manually via "Draft this".
- The `REVIEW_CHECKPOINT` summary only reports counts; it does not use engagement metrics.

## 13. Related documents

- [Campaign & Outreach creation](../../../CAMPAIGN-OUTREACH-CREATION.md)
- [Content plan performance](../../../CONTENT-PLAN-PERFORMANCE.md)
- [Sprint 6 technical](../../../SPRINT-6-TECHNICAL.md)
- [Approval model](../../../APPROVAL-MODEL.md)
- [Recommendation creation](../../../RECOMMENDATION-CREATION.md)
- [Product documentation](../../../PRODUCT-DOCUMENTATION.md)
- Sibling features: [09 Recommendations & Aura Suggests](../09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md), [18 Marketing Memory & Analytics](../18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md), [23 AI layer](../23-ai-layer/01-FEATURE-DETAILS.md)
- Architecture: [02-ARCHITECTURE.md](./02-ARCHITECTURE.md)
