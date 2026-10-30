# Lead Discovery & Outreach Intelligence

> This feature finds companies and people worth contacting, scores how well they fit, and drafts personal LinkedIn outreach for each one. A human approves every message and sends it by hand. Leads come from three places: reactive **signal detection** (funding, hiring, GitHub activity, news), proactive **discovery profiles** (saved "who do we want to reach" searches over GitHub, Crunchbase, Google Custom Search and company team pages), and **manual entry**. Each lead gets an AI connection note (LinkedIn's 300-character limit) and a follow-up, written in the brand voice and grounded in a real public signal. Messages go through the same approve/reject flow as Content Studio. Approved messages appear in the Chrome extension's queue, and only a human click there marks them `SENT`. Nothing touches LinkedIn from the server, and nothing is scraped from LinkedIn.

## 1. Overview

- **Two ways in, one list.** `Lead` rows carry a `source` (`SIGNAL`, `DISCOVERY_ENGINE`, `MANUAL`) and a `category` (the requirement they came from, e.g. "Distillery"). The Leads page and the Outreach board both read through `server/outreach/lead.service.ts`. A lead that appears on one screen therefore always appears on the other.
- **Signal detection** (Sprint 4, `server/outreach/detect.service.ts`):
  - Runs the enabled public sources against the workspace's `OutreachConfig`.
  - Filters and dedupes the results with pure functions (`server/outreach/matching.ts`).
  - Upserts one `Lead` per target company and attaches a `LeadSignal`.
- **Discovery engine** (Sprint 5, `server/leads/discovery/`):
  - Runs a `DiscoveryProfile` against GitHub orgs, Crunchbase, Google CSE, and robots-gated company team pages.
  - Dedupes candidates against each other and against existing leads (`dedup.ts`).
  - Creates at most 25 new leads per run and AI-scores each one 0-100 with matched/missed criteria (`scoring.ts`).
  - Records every run as a `DiscoveryRun`.
- **Drafting** (`server/outreach/drafting.service.ts`):
  - Produces two `OutreachMessage` rows per lead: a `CONNECTION_NOTE` (clipped to 300 chars) and a `FOLLOWUP`.
  - Grounded in the newest signal, the knowledge base (`retrieve`) and the Business Context `outreach` preset.
  - Falls back to a deterministic template when no AI provider is configured.
- **Approval** (`server/outreach/outreach.service.ts`): a state machine that mirrors content approval. Blocking checks (`outreach-checks.service.ts`) cover empty text, the 300-char limit, placeholders and workspace compliance rules. Concurrent approvals are refused.
- **Bulk approval with a confidence gate** (`server/outreach/confidence.ts`): only drafts that score at least 70 are offered for one-click bulk approval. The rest stay in the queue for a human to read.
- **Hand-off to the extension**: approved and unchanged messages appear in `/api/extension/queue`. The extension's "Mark as sent" sets `SENT`, stamps `sentAt` and moves the lead to `CONTACTED`. See [17 Chrome Extension](../17-chrome-extension/).
- **Outcome capture**: a human records `connectionAccepted` / `replyReceived` on sent messages. These feed Marketing Memory ([18](../18-marketing-memory-and-analytics/)).
- **From a recommendation**: `/dashboard/outreach/new?rec=…` drafts for up to 5 chosen leads from an Aura suggestion's creation context. Sending stays blocked by `lib/execution-gate.ts` (`CONTEXTUAL_EXECUTION_ENABLED = false`).

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
|---|---|---|---|
| Leads | `/dashboard/leads` (`app/dashboard/leads/page.tsx` + `components/dashboard/leads/leads-table.tsx`) | See every lead, grouped by requirement. Filter by requirement, source (Discovery / Signal / Manual), status and a minimum fit score. Select leads and **Send to outreach** (`NEW`/`ARCHIVED` → `QUALIFIED`). **Draft** outreach per lead. Mark a lead **Not relevant** with a reason (archives it and stores `irrelevantReason`). | View: any member. Act: OWNER, ADMIN (`content:approve`). |
| Discover leads | `/dashboard/leads/discover` (`discovery-manager.tsx`) | Create discovery profiles: name, lead category, criteria (industries, company stages, role titles, geographies, keywords) and a weekly auto-run flag. Open an **Estimate** before running (sources that will run, expected results, time, AI calls/tokens, warnings). **Run now**, edit, delete. See the last 20 runs with per-source counts and skipped sources. | View: any member. Manage/run: OWNER, ADMIN. |
| Lead detail | `/dashboard/leads/[id]` | Fit score, rationale, matched/missed criteria, signals, messages, originating profile. Draft outreach (`lead-draft-button.tsx`). | View: any member. Draft: OWNER, ADMIN. |
| Outreach Intelligence | `/dashboard/outreach` (`outreach-board.tsx`, `outreach-queue-bar.tsx`, `outreach-history.tsx`) | Per-lead board with signals and messages. Edit message text (sends it back to `DRAFT`). Submit, approve, reject or request changes. Delete a lead. Edit lead name/title/LinkedIn URL. **Detect signals** (`detect-button.tsx`). **Add lead** manually (`create-lead-dialog.tsx`). The queue bar offers bulk approval of the confident drafts and flags approved messages waiting 3+ days (`STALE_AFTER_DAYS = 3`). History shows sent/connected/replied counts and outcome toggles. `?category=` pre-filters by requirement. | View: any member. Act: OWNER, ADMIN. |
| Outreach from a suggestion | `/dashboard/outreach/new?rec=<id>` (`outreach-from-suggestion.tsx`) | Shows the recommendation's creation context and lets the user pick up to 5 leads to draft for. Redirects to `/dashboard/outreach` without `rec`. | Draft: OWNER, ADMIN. Accepting a still-open suggestion also needs `company:update`. |
| Outreach targeting | `/dashboard/settings/outreach` (`outreach-config-form.tsx`) | Edit industries, role titles, company stages and the enabled sources (Crunchbase, GitHub, jobs, news). | Edit: OWNER, ADMIN (`company:update`). |

Outreach messages also appear in the unified review queue (`server/review/review-item.service.ts`, `review-actions.service.ts`). There they can be regenerated (`regenerateMessage`, which keeps the last 5 texts in `aiMetadata.history`) and checked with `checkOutreachMessage`.

## 3. How it works

### 3.1 Signal detection (`detectForCompany`)

1. Load the workspace's `OutreachConfig`, creating it lazily with defaults (`ensureOutreachConfig`). Default sources are `{ crunchbase: false, github: true, jobs: true, news: true }`.
2. Search terms are `industries + companyStages`. Each source runs only when it is enabled and has input:
   - GitHub and news run on those terms.
   - Jobs runs on `roleTitles`.
   - Crunchbase runs when enabled. Its credential comes from the workspace connector (`resolveCredential(companyId, 'crunchbase')`), falling back to `CRUNCHBASE_API_KEY`. If no key is available, it is reported in `skipped`.
3. `filterSignals`:
   - A signal matches when any lowercased criteria term (industries, role titles, stages) appears in its company name or description.
   - With no terms configured, everything matches, so a new workspace still sees signal.
   - Matches are then deduped by `signalType + lowercased company`.
4. For each signal, find a `Lead` with the same `companyName` or create one (`status NEW`, `source` defaults to `SIGNAL`). Skip a `LeadSignal` whose description already exists on that lead.
5. Audit `LEAD_CREATED` per new lead and one `LEAD_SIGNAL_DETECTED` summary. Return `{ leadsCreated, signalsAdded, skipped }`.

### 3.2 Discovery run (`runDiscovery`)

1. Load the profile (scoped to the workspace) and the Business Context `targeting` section, rendered once per run as a `qualification` preamble.
2. Create a `DiscoveryRun(RUNNING)` and audit `DISCOVERY_RUN_STARTED`.
3. Query three sources in parallel:
   - `discoverGitHubCompanies`: GitHub `search/users` with `type:org`, 5 per term, at most 3 terms taken from keywords + industries.
   - `discoverCrunchbaseCompanies`: Crunchbase v4 organization search. Uses the workspace connector, falling back to `CRUNCHBASE_API_KEY`.
   - `discoverViaSearch`: Google Custom Search, `num=5`. Uses the `google-cse` connector, falling back to `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX`.
4. Every GitHub/Crunchbase company becomes a company-level candidate. For the first 8 companies with a website (`MAX_COMPANIES_FOR_SITE = 8`), `discoverPeopleFromSite`:
   - Fetches `/team`, `/about`, `/about-us`, `/leadership`, `/company`, `/people` through `politeFetchHtml` (robots.txt-gated) and keeps the first page with more than 200 characters of text, up to 8,000 characters.
   - Asks the AI to extract only explicitly named leaders (at most 12).
   - With no AI configured, it returns nothing rather than guessing names.
5. Deduplicate:
   - `dedupeWithin` merges candidates. Two candidates are the same company when their normalized names match or their token Jaccard overlap is ≥ 0.6. Legal suffixes (`inc`, `llc`, `ltd`, `corp`, `co`, `gmbh`, `plc`, `limited`) are stripped first.
   - They are the same person when the names match exactly, one name with at least 2 tokens is a subset of the other, or the Jaccard overlap is ≥ 0.7.
   - A company-level lead and a named person at that company are kept apart.
   - `findExistingMatch` then skips anything already in the workspace's leads.
6. Create up to `MAX_NEW_LEADS = 25` leads. Each one gets `source DISCOVERY_ENGINE`, `discoveryProfileId`, `category` (the profile's category, or its name) and `status NEW`. Audit `LEAD_DISCOVERED`.
7. Score each new lead (`scoreLead`):
   - With AI configured: a `completeStructured` call (`tier: 'cheap'`, `effort: 'low'`, `maxTokens: 1000`) returns `fitScore`, a one-sentence `fitRationale`, and `matched` / `missed` lists (at most 12 each).
   - Without AI, or when the call fails, a deterministic weighted term overlap is used:
     - Weights: industry 30, role 25, keyword 20, stage 15, geography 10. Partial credit is proportional to the hits in each group.
     - +5 evidence bonus when the score is above 0.
     - Exactly 50, with an explanation, when no criteria are set.
   - Audit `LEAD_SCORED`.
8. Mark the run `COMPLETED` with `leadsFound`, `leadsCreated` and `summary` (`perSource`, `skipped`, `candidates`, `category`), and stamp the profile's `lastRunAt`, in one transaction. On error the run becomes `FAILED` with the error in `summary`.

**Estimate** (`server/leads/discovery/estimate.ts`): a pre-run forecast built from the profile's criteria, which credentials resolve, and up to 5 past completed runs.

- **Typical results per source:** GitHub 6, Crunchbase 12, CSE 8, team pages 10.
- **History:** when there is history, the min/max are taken from it.
- **Tokens:** about 250 output tokens per scoring call and about 400 per team-page extraction.
- **Warnings:** shown when there are no criteria, or when Crunchbase or CSE is not connected.

### 3.3 Drafting (`draftForLead`)

1. Load the lead (workspace-scoped), its newest `LeadSignal` and the company.
2. With AI configured:
   - Retrieve 4 knowledge chunks for `"<leadCompany> <signal>"` and make sure the brand-voice profile exists.
   - Build the system prompt from `businessContextToPrompt(context, { ...WORKFLOW_PRESETS.outreach, knowledge: false })` plus rules: reference the actual signal, no clichés, note under 300 characters, follow-up only after acceptance.
   - Call `completeStructured` (`maxTokens 800`, `effort medium`, `tier standard`).
   - When drafting from a recommendation, `creationContextPrompt` is appended.
3. Without AI, or on failure: deterministic text ("Hi <first name> — noticed <company>: <signal>…"), `model: 'none'`.
4. In one transaction:
   - Create the two `OutreachMessage(DRAFT)` rows. `aiMetadata` holds `model`, `signalId`, `brandVoiceApplied`, `versions`, plus the recommendation/creation context when present.
   - Set the lead to `DRAFTED`.
   - Audit `OUTREACH_DRAFTED`.

### 3.4 Approval state machine (`transitionMessage`)

| From | Allowed to |
|---|---|
| `DRAFT` | `PENDING_APPROVAL`, `APPROVED`, `REJECTED` |
| `PENDING_APPROVAL` | `APPROVED`, `REJECTED`, `DRAFT` |
| `APPROVED` | `REJECTED`, `DRAFT` |
| `REJECTED` | `DRAFT` |
| `SENT` | (final) |

- **Actions map to statuses:** `submit` → `PENDING_APPROVAL`, `approve` → `APPROVED`, `reject` → `REJECTED`, `request_changes` → `DRAFT`.
- **Role check:** every action needs `content:approve`.
- **Duplicates:** approving an approved message or rejecting a rejected one returns 409 `duplicate`.
- **Blocking checks on approve:** `checkOutreachMessage` blocks approval on any of the following (409 `outreach_checks_failed`):
  - empty text
  - a connection note over 300 characters
  - a placeholder such as `[name]` or `{{…}}`
  - a failed workspace compliance rule (via `checkCompliance`, which also checks competitor names)
- **Concurrency:** the write is a compare-and-set on the read status. A concurrent change returns 409 `concurrent_change`.
- **Approval record:** `aiMetadata` keeps it (`outreachMetaAfter`, `withApprovedMessageVersion`).
- **Editing:** `updateMessageText` moves any non-sent message back to `DRAFT` and stores a new version.

### 3.5 Bulk approval confidence (`scoreConfidence`)

Points: signal cited +30, brand voice applied by a real model +20, fit ≥ 70 +25 (fit 45-69 +12), named contact +15, LinkedIn URL +10. Missing essentials **cap** the score instead of subtracting:

| Condition | Cap |
|---|---|
| No signal | 60 |
| Fallback wording / no brand voice | 60 |
| Fit < 70 or unscored | 55 |
| No named contact | 50 |
| No LinkedIn URL | 65 |
| Text under 40 chars, or a connection note over 300 | 40 |
| Unfilled placeholder (`[..]`, `{{..}}`, `TODO`, `XXX`) | 25 |

`BULK_APPROVE_THRESHOLD = 70`. `GET /api/outreach/messages/bulk` returns `confidentIds` and `needsReview` (with score and concerns). `POST` runs the normal `transitionMessage` for each id in sequence (at most 100), so one failure does not abort the batch.

### 3.6 Sending and outcomes

- **Queue:** `getQueue` (extension) lists up to 50 `APPROVED` messages that pass `outreachIntact` and are not held by the execution gate.
- **Sending:** `completeOutreachMessage` (extension) re-checks role, status, integrity and the gate, then sets `SENT` / `sentAt`, sets the lead to `CONTACTED`, and audits `OUTREACH_SENT`.
- **Outcomes:** `POST /api/outreach/messages/:id/outcome` calls `setOutreachOutcome` (`server/memory/performance.service.ts`).

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | `app/dashboard/leads/page.tsx` | Leads list + category counts (`listLeadSummaries`, `listLeadCategories`) |
| Page | `app/dashboard/leads/discover/page.tsx` | Discovery profiles + run history |
| Page | `app/dashboard/leads/[id]/page.tsx` | Lead detail (`getLeadDetail`) |
| Page | `app/dashboard/outreach/page.tsx` | Outreach board, queue bar, history, stale-approved flag |
| Page | `app/dashboard/outreach/new/page.tsx` | Draft outreach from a recommendation |
| Page | `app/dashboard/settings/outreach/page.tsx` | Targeting settings |
| Component | `components/dashboard/leads/leads-table.tsx` | Filters, grouping, send-to-outreach, draft, "not relevant" |
| Component | `components/dashboard/leads/discovery-manager.tsx` | Profile form, estimate, run, delete |
| Component | `components/dashboard/leads/lead-draft-button.tsx` | Draft button on lead detail |
| Component | `components/dashboard/outreach/outreach-board.tsx` | Lead cards, message edit/approve/reject, outcomes |
| Component | `components/dashboard/outreach/outreach-queue-bar.tsx` | Bulk approval of confident drafts |
| Component | `components/dashboard/outreach/outreach-history.tsx` | Sent/connected/replied summary |
| Component | `components/dashboard/outreach/create-lead-dialog.tsx`, `detect-button.tsx`, `outreach-config-form.tsx`, `outreach-from-suggestion.tsx` | Manual lead, detection trigger, settings form, recommendation hand-off |
| API | `app/api/leads/**`, `app/api/outreach/**` | See section 6 |
| Cron | `app/api/cron/discovery/route.ts`, `app/api/cron/outreach/route.ts` | Weekly auto-run / daily detection |
| Service | `server/leads/discovery/discovery.service.ts` | `runDiscovery` orchestrator |
| Service | `server/leads/discovery/estimate.ts` | `estimateDiscoveryRun` |
| Service | `server/leads/discovery/scoring.ts` | `scoreLead`, `deterministicScore` |
| Service | `server/leads/discovery/dedup.ts` | `normalize`, `jaccard`, `isSameLead`, `dedupeWithin`, `findExistingMatch` |
| Service | `server/leads/discovery/sources/{github,crunchbase,google-cse,company-site}.ts` | Discovery sources |
| Service | `server/leads/profile.service.ts`, `detail.service.ts` | Profile CRUD + run history; lead detail |
| Service | `server/outreach/detect.service.ts`, `matching.ts`, `sources/{github,news,google-news,jobs,crunchbase}.ts` | Signal detection |
| Service | `server/outreach/lead.service.ts` | Lead list/summaries/categories, create (dedup + enrich), update, remove, `sendLeadsToOutreach` |
| Service | `server/outreach/drafting.service.ts` | `draftForLead`, `regenerateMessage` |
| Service | `server/outreach/outreach.service.ts` | `transitionMessage`, `updateMessageText`, `listOutreachHistory` |
| Service | `server/outreach/outreach-checks.service.ts`, `confidence.ts`, `config.service.ts` | Checks, bulk confidence, targeting config |
| Lib | `lib/validations/outreach.ts`, `lib/validations/discovery.ts` | Zod schemas |
| Lib | `lib/outreach-ui.ts` | Status/type/signal labels, badge variants, stepper steps |
| Lib | `lib/linkedin-url.ts` | `classifyLinkedInUrl` (person/company/unknown). Used by engagement and competitor forms. |
| Lib | `lib/execution-gate.ts`, `lib/creation-handoff.ts` | Hold on sending recommendation-drafted outreach; creation context |
| Tests | `tests/lead-dedup.test.ts`, `tests/lead-scoring.test.ts`, `tests/outreach-confidence.test.ts`, `tests/outreach-matching.test.ts` | Pure logic |

## 5. Data model

| Model / enum | Key fields | Notes |
|---|---|---|
| `OutreachConfig` | `companyId` (unique), `industries[]`, `roleTitles[]`, `companyStages[]`, `enabledSources` JSON | 1:1 with `Company`, created lazily |
| `Lead` | `companyName`, `name?`, `title?`, `sourceUrl?`, `linkedInProfileUrl?`, `status LeadStatus`, `source LeadSource`, `discoveryProfileId?`, `fitScore?`, `fitRationale?`, `fitMatched[]`, `fitMissed[]`, `irrelevantReason?`, `irrelevantAt?`, `category?` | Indexed on `(companyId, status)`, `(companyId, source)`, `(companyId, category)`, `(companyId, updatedAt)`. `category` is denormalized on purpose so it survives profile rename/delete. |
| `LeadSignal` | `leadId`, `signalType SignalType`, `description`, `sourceUrl?`, `detectedAt` | Cascade-deleted with the lead |
| `OutreachMessage` | `leadId`, `companyId`, `type OutreachType`, `status OutreachStatus`, `draftText`, `aiMetadata` JSON, `rejectionReason?`, `sentAt?`, `connectionAccepted`, `replyReceived` | `aiMetadata` holds model, signalId, brandVoiceApplied, versions, approval record, history, recommendation context. Related to `PerformanceSnapshot`. |
| `DiscoveryProfile` | `name`, `category?`, `criteria` JSON, `isActive`, `autoRun`, `lastRunAt?` | `criteria` is validated by `discoveryCriteriaSchema` (5 string lists, ≤ 40 items of ≤ 80 chars) |
| `DiscoveryRun` | `discoveryProfileId`, `status DiscoveryRunStatus`, `leadsFound`, `leadsCreated`, `summary` JSON, `startedAt`, `finishedAt?` | Run history; also counted for the plan limit |
| Enums | `LeadStatus` (NEW, QUALIFIED, DRAFTED, CONTACTED, ARCHIVED), `SignalType` (FUNDING, HIRING, GITHUB_ACTIVITY, NEWS, LEADERSHIP_CHANGE), `OutreachType` (CONNECTION_NOTE, FOLLOWUP), `OutreachStatus` (DRAFT, PENDING_APPROVAL, APPROVED, SENT, REJECTED), `LeadSource` (SIGNAL, DISCOVERY_ENGINE, MANUAL), `DiscoveryRunStatus` (RUNNING, COMPLETED, FAILED) | |

## 6. API endpoints

All routes use session auth via `requireActiveCompany()` unless noted. Full reference: [INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| GET | `/api/leads/discovery/profiles` | List profiles | Member |
| POST | `/api/leads/discovery/profiles` | Create profile | `content:approve` |
| PATCH / DELETE | `/api/leads/discovery/profiles/:id` | Update / delete profile | `content:approve` |
| GET | `/api/leads/discovery/profiles/:id/estimate` | Pre-run estimate | Member |
| POST | `/api/leads/discovery/profiles/:id/run` | Run discovery now (`maxDuration 60`) | `content:approve` + `requireEntitlement('discovery')` |
| POST | `/api/leads/:id/irrelevant` | Archive with a reason (3-500 chars); audits `LEAD_MARKED_IRRELEVANT` | `content:approve` |
| GET / PUT | `/api/outreach/config` | Read / update targeting | GET member; PUT `company:update` |
| POST | `/api/outreach/detect` | Run signal detection now | `content:approve` |
| GET / POST | `/api/outreach/leads` | List / create (manual, dedup + enrich) | GET member; POST `content:approve` |
| POST | `/api/outreach/leads/send-to-outreach` | Promote 1-200 leads to `QUALIFIED` | `content:approve` |
| PATCH / DELETE | `/api/outreach/leads/:id` | Edit / remove lead | `content:approve` |
| POST | `/api/outreach/leads/:id/draft` | Draft connection note + follow-up | `content:approve` |
| POST | `/api/outreach/from-recommendation` | Draft for 1-5 leads from a suggestion | `content:approve` (+ `company:update` if it accepts the suggestion) |
| PATCH | `/api/outreach/messages/:id` | Edit text (1-3000 chars), back to `DRAFT` | `content:approve` |
| POST | `/api/outreach/messages/:id/status` | `submit` / `approve` / `reject` / `request_changes` | `content:approve` |
| GET | `/api/outreach/messages/bulk?status=` | Bulk eligibility split by confidence (`DRAFT`, `PENDING_APPROVAL`, `APPROVED`) | Member |
| POST | `/api/outreach/messages/bulk` | Approve / reject / submit up to 100 messages | `content:approve` |
| POST | `/api/outreach/messages/:id/outcome` | Record connection accepted / reply received | `content:approve` |
| GET/POST | `/api/cron/discovery`, `/api/cron/outreach` | Scheduled runs | `Authorization: Bearer $CRON_SECRET` |

## 7. External services

| Service | Used by | Credential |
|---|---|---|
| GitHub REST API (`api.github.com`) | Discovery companies, outreach signals | Optional `GITHUB_TOKEN` (raises rate limit) |
| Crunchbase v4 API | Discovery companies, funding signals | Workspace `crunchbase` connector or `CRUNCHBASE_API_KEY` |
| Google Custom Search JSON API | Discovery | Workspace `google-cse` connector (key + `cx` metadata) or `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` |
| Google News RSS (`news.google.com/rss/search`) | News signals | None |
| Company websites (robots.txt-gated, `BotellaAuraBot/0.1` user agent) | Team-page people extraction | None |
| AI provider via `server/ai/claude.ts` | Fit scoring, people extraction, drafting | See [23 AI Layer](../23-ai-layer/). Everything degrades to deterministic output when unconfigured. |

No LinkedIn API is called and no LinkedIn page is fetched. Environment reference: [ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

| Route | Intended schedule (from the route comment) | Work |
|---|---|---|
| `GET`, `POST` `/api/cron/discovery` | `0 11 * * 1` (weekly, Monday) | `runDiscovery` for every profile with `isActive && autoRun`. Errors are counted per profile. |
| `GET`, `POST` `/api/cron/outreach` | `0 12 * * *` (daily) | `detectForCompany` for every company |

Both check `Authorization: Bearer $CRON_SECRET` and export `GET = POST` for Vercel Cron. **Neither is listed in `vercel.json`**, which only schedules `publish`, `briefing` and `connections`. They have to be triggered externally. The cron discovery path does not call `requireEntitlement`.

## 9. Security & permissions

- **Workspace scoping:** every service query filters by `companyId`. `getLeadOrThrow`, `getMessageOrThrow` and `getProfileOrThrow` return 404 for another workspace's ids. The bulk route re-checks each id inside `transitionMessage`.
- **RBAC** (`lib/rbac.ts`): all writes and AI-spending actions need `content:approve` (OWNER, ADMIN). Targeting settings need `company:update`. MEMBER and VIEWER can read the lists. `transitionMessage` also re-checks the role when one is passed.
- **Human gate:** nothing reaches `SENT` without an approval plus a human click in the extension. Edits after approval reopen the message (`outreachIntact` blocks the queue and the sync-back otherwise).
- **Validation:** Zod schemas cap list sizes and lengths. URLs are normalized to `https://`.
- **Audit:**
  - Discovery: `DISCOVERY_PROFILE_*`, `DISCOVERY_RUN_*`, `LEAD_DISCOVERED`, `LEAD_SCORED`
  - Leads: `LEAD_CREATED`, `LEAD_UPDATED`, `LEAD_REMOVED`, `LEAD_SENT_TO_OUTREACH`, `LEAD_MARKED_IRRELEVANT`, `LEAD_SIGNAL_DETECTED`
  - Outreach: `OUTREACH_CONFIG_UPDATED`, `OUTREACH_DRAFTED`, `OUTREACH_SUBMITTED_FOR_APPROVAL`, `OUTREACH_APPROVED`, `OUTREACH_REJECTED`, `OUTREACH_SENT`
- **Public data only:** the source modules never read LinkedIn. Person identity comes from public team pages or the user.

## 10. Testing

- `tests/lead-dedup.test.ts`: normalization, Jaccard, company/name matching, in-batch merge, existing-lead matching.
- `tests/lead-scoring.test.ts`: `deterministicScore` (full vs partial vs none, matched/missed, weighting, no-criteria case, 0-100 range).
- `tests/outreach-confidence.test.ts`: caps for no signal, no contact, weak fit, placeholders, over-limit notes, short drafts, fallback wording; range.
- `tests/outreach-matching.test.ts`: `criteriaTerms`, `signalMatches`, `dedupeSignals`, `filterSignals`, outreach schemas.
- Verify scripts that exercise outreach (against a running app): `pnpm verify:approval`, `pnpm verify:unified-review`, `pnpm verify:versions`, `pnpm verify:permissions`, `pnpm verify:creation`.

## 11. Configuration & limits

| Setting | Value | Source |
|---|---|---|
| New leads per discovery run | 25 | `MAX_NEW_LEADS` |
| Companies whose team pages are read | 8 | `MAX_COMPANIES_FOR_SITE` |
| Team-page text sent to AI | 8,000 chars | `MAX_TEXT` |
| Leads loaded per board/table | 500 | `MAX_LEADS` in `lead.service.ts` |
| Signals / messages per lead on the board | 5 / 10 | `listLeads` |
| Run history shown | 20 | `listRuns` |
| Connection note limit | 300 chars | `CONNECTION_NOTE_LIMIT` |
| Bulk approve threshold | 70 | `BULK_APPROVE_THRESHOLD` |
| Bulk batch size | 100 messages | bulk route schema |
| Leads per recommendation draft | 5 | `MAX_LEADS` in `from-recommendation` |
| Stale approved flag | 3 days | `STALE_AFTER_DAYS` |
| Discovery runs per month | Trial 10, Starter 25, Growth 150, Agency 2000 | `server/billing/entitlements.ts` |
| Env vars | `CRUNCHBASE_API_KEY`, `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX`, `GITHUB_TOKEN`, `CRON_SECRET`, AI provider keys | all optional |

## 12. Known limitations & future work

- **Cron schedules are not deployed.** `/api/cron/discovery` and `/api/cron/outreach` are absent from `vercel.json`, so weekly auto-run and daily detection only happen if an external scheduler calls them.
- **Recommendation-drafted outreach cannot be sent yet.** `CONTEXTUAL_EXECUTION_ENABLED = false` keeps those messages out of the extension queue.
- **Irrelevant reasons are stored but not yet fed into the next run.** The route comment describes this intent; `runDiscovery` does not read `irrelevantReason`.
- **Signal leads are matched on exact `companyName`.** `detectForCompany` does not use the fuzzy `dedup.ts` matching, so name variants can create separate signal leads.
- **Long runs.** Discovery runs inline in a 60-second request. Team-page reads are sequential.
- **Outcomes are manual.** No API reports LinkedIn connection acceptance or replies; the user toggles them.
- **No pagination.** Lists are capped at 500 leads rather than paginated.

## 13. Related documents

- [SPRINT-4-TECHNICAL.md](../../../SPRINT-4-TECHNICAL.md), section 6 (Outreach Intelligence)
- [SPRINT-5-TECHNICAL.md](../../../SPRINT-5-TECHNICAL.md) (Lead Discovery Engine, outcomes)
- [CAMPAIGN-OUTREACH-CREATION.md](../../../CAMPAIGN-OUTREACH-CREATION.md) (outreach from a recommendation)
- [APPROVAL-MODEL.md](../../../APPROVAL-MODEL.md), [UNIFIED-REVIEW.md](../../../UNIFIED-REVIEW.md), [VERSIONS.md](../../../VERSIONS.md)
- [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md), [PRODUCT-DOCUMENTATION.md](../../../PRODUCT-DOCUMENTATION.md)
- Sibling features: [17 Chrome Extension](../17-chrome-extension/), [16 Engagement Copilot](../16-engagement-copilot/), [09 Recommendations](../09-recommendations-and-aura-suggests/), [13 Review & Approval](../13-review-approval-versions-and-trace/), [18 Marketing Memory](../18-marketing-memory-and-analytics/), [19 Connections](../19-connections-and-connectors/), [22 Billing](../22-billing-and-plans/), [05 Business Context](../05-business-context/)
- [Architecture](./02-ARCHITECTURE.md)
