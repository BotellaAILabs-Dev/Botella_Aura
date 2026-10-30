# Business Context & About My Business

> The Business Context is one resolved structure for everything Aura knows about a workspace's business: who it is, who it sells to, its goals, channels, voice, market, materials, learned patterns and recent history. Every AI workflow (content, opportunities, recommendations, outreach, engagement, planning, the advisor, lead qualification, image prompts) reads the business through this layer, and every screen that edits business information writes through one validated service. Each fact records where it came from, how far it can be trusted and how current it is. The **About my business** page (`/dashboard/business`) shows the user the context exactly as Aura reads it. The page lets people edit and confirm facts and answer Aura's questions about what is missing. The feature exists because the same facts used to be stored in several places, and each workflow read its own subset.

## 1. Overview

The feature has five parts:

| Part | What it does | Main code |
| --- | --- | --- |
| **Model and field registry** | Defines the `BusinessContext` schema (version `2`), the 14 context sources, source types, confidence levels, freshness rules, and the 24 registered fields. For each field it records whether it is required, recommended or optional, its source precedence, its resolution strategy, and which modules consume it. | `lib/business-context.ts` |
| **Read service and builder** | Loads every source in parallel, then resolves conflicts, records provenance, derives per-fact trust and freshness, lists issues and scores completeness. Renders per-workflow prompt preambles. | `server/business-context/business-context.service.ts`, `build.ts`, `facts.ts` |
| **Write service** | `updateBusinessContext` is the only writer of business information. It runs a strict patch schema, update rules R1–R9, a compare-and-swap transaction, optimistic concurrency and an audit entry. | `lib/validations/business-context.ts`, `server/business-context/update.ts`, `business-context-write.service.ts`, `adapters.ts` |
| **Snapshot** | A compact, bounded, stored statement of trusted facts for AI workflows. Facts that are only assumed are kept apart. It has a content fingerprint and is refreshed by source stamp, TTL or invalidation. | `lib/business-context-snapshot.ts`, `server/business-context/snapshot.ts`, `snapshot.service.ts` |
| **Questions** | Detects missing, stale, unverified and conflicting facts, and turns them into questions with anti-nagging rules. | `lib/business-context-questions.ts`, `server/business-context/questions.service.ts` |

A coverage audit (`server/business-context/coverage.ts`, run by `pnpm verify:context-sources`) checks every stored business value. Each one must be reachable in the context, superseded with a recorded conflict, or intentionally unmapped for a stated reason.

## 2. User-facing behaviour

### About my business — `/dashboard/business`

Server page `app/dashboard/business/page.tsx` (metadata title "About my business", `dynamic = 'force-dynamic'`). The sidebar lists it in the `setup` group (`lib/nav.ts`) as "About my business".

The page loads the full context once with `getBusinessContext(active.id)` and the caller's membership. From that context it derives up to 3 questions with `getQuestions(..., { context, limit: 3, markAsked: canEdit, focusField: searchParams.ask })`. It renders two components:

1. **`AuraQuestions`** (`components/dashboard/business/aura-questions.tsx`): the "Aura has a few questions" card.
   - Question types: text, long text, a choice (B2B/B2C, or which of two conflicting values is right), a multi-choice (channels), or a link to another page.
   - Stale and AI-drafted values also offer **"Yes, that's right"**, which confirms the value without changing it.
   - Every question offers **"Not now"**. Non-critical questions also offer **"Doesn't apply to us"**. Critical questions carry a "Needed" badge.
   - Actions call `POST /api/business-context/questions`, then `router.refresh()`.
2. **`BusinessContextView`** (`components/dashboard/business/business-context-view.tsx`):
   - **Completeness card.** Shows a score from 0 to 100% and a progress bar. The heading is either "Aura has what it needs" or "Aura is missing key information". Below it is the attention list from `attentionItems()`: missing required fields, then stale and conflicting values, then missing recommended fields, then AI suggestions awaiting review. Each item opens the matching field editor or links to the page that owns the data.
   - **Your business.** Name, description, offerings, industry and website. All are editable.
   - **Who you sell to.** Market mode and stated audience are editable. A read-only row shows buyer roles and industries, which are owned by Outreach targeting and Lead discovery.
   - **Goals.** Goals are editable. A read-only row shows running campaigns.
   - **Channels.** Preferred channels are editable. A read-only row shows "Connected to Aura" and links to `/dashboard/settings/connections`.
   - **Brand.** Shows voice notes and the voice profile with a confirm button, and links to `/dashboard/settings/knowledge-base`. Logo and colours link to `/dashboard/settings/brand`.
   - **Your market.** Competitors, with AI-suggested ones flagged "Suggested by AI and not confirmed — track or remove it." Links to `/dashboard/competitors`.
   - **What Aura has learned.** Memory insights and recent content, with links to `/dashboard/memory` and `/dashboard/content`.
   - Each fact row shows a **source** pill and a **freshness** pill (`sourceIndicator`, `freshnessIndicator` in `lib/business-context-ui.ts`). It shows a **Confirm** button when `confirmTarget()` allows one: the value is stored (not borrowed from a fallback) and is untrusted, stale or of unknown age.

**Deep link `?ask=<field>`.** Other pages send users here for one specific field. Examples: `lib/content-brief.ts` links to `?ask=identity.description`, `lib/visual-brief.ts` to `?ask=identity.offerings`, and `lib/data-readiness.ts` builds `?ask=<field>#aura-questions`. The focused field's question moves to the front and is shown even if it is snoozed or resting. A dismissal still holds.

**Saving.** Every edit and confirmation is a `PATCH /api/business-context` that carries `expectedRevision`.
- The component keeps the newest revision in a ref and updates it from the save response. This stops a second quick save from being refused as stale.
- A 409 shows the banner "Someone else changed this page while you had it open…" with a Reload button.
- A 422 shows the first per-field message.

### Roles

| Role | Can view page and GET APIs | Can edit, confirm, answer, snooze/dismiss, force snapshot rebuild |
| --- | :-: | :-: |
| OWNER | ✓ | ✓ (`company:update`) |
| ADMIN | ✓ | ✓ (`company:update`) |
| MEMBER | ✓ | ✗ |
| VIEWER | ✓ | ✗ |

Users without `company:update` see "You have view-only access. Ask an owner or admin to change your business details." Questions shown to them are not counted as asked (`markAsked: canEdit`).

## 3. How it works

### 3.1 Reading: `getBusinessContext(companyId, options)`

1. **Load.** The `Company` row is always read: `name`, `website`, `industry`, `brandVoiceNotes`, `brandVoiceProfile`, `preferences`, `updatedAt` and `logoUrl`. Optional sections (`CONTEXT_SECTIONS`) load in parallel when they are requested. The default is all of them.

   | Section | Queries |
   | --- | --- |
   | `targeting` | `OutreachConfig`, plus up to 3 active `DiscoveryProfile` rows, newest first |
   | `market` | All `CompetitorProfile` rows, `CompanyTrendConfig`, and a count of `TREND_CONFIG_UPDATED` audit entries (used to tell a person's list from an AI seed) |
   | `plan` | The latest `MarketingPlan` by month, plus up to 5 `Campaign` rows with status ACTIVE or PAUSED |
   | `connections` | `Connection` rows with status CONNECTED (excluding mirrored ones, `NOT_MIRRORED`) and an ACTIVE `LinkedInConnection` |
   | `knowledge` | `KnowledgeChunk` grouped by category and sourceType, and WEBSITE `KnowledgeSource` URLs |
   | `memory` | Up to 50 active `MarketingMemory` rows |
   | `history` | Up to 10 `ContentDraft` rows with status PUBLISHED or APPROVED updated in the last 90 days, and the latest `AnalyticsReport` |

   A `query` option also retrieves knowledge passages with `retrieve()` (default `knowledgeLimit` 6).
2. **Resolve** (`buildBusinessContext`, pure). Each field is resolved by its registry strategy:
   - `precedence`: the first source with a value wins. A different value in a lower source becomes a `value_conflict` issue.
   - `union`: lists are merged and de-duplicated case-insensitively. The earlier source's spelling is kept.
   - `layered`: the voice profile, then onboarding notes, then plan guidelines. Differences between them are expected and not reported.

   Specific rules:
   - The knowledge-base website is a fallback only when exactly one WEBSITE source exists. Websites are compared by host, ignoring `www.`.
   - A competitor that appears only on the trend watch list is kept but untracked, and reported as a `consistency` note. When the watch list was AI-seeded, the competitor is marked `ai_derived` / `unverified`.
   - Memory insights with `supportingDataSummary.status = 'insufficient'` are dropped. The rest are ranked user-edited first, then by confidence, then by sample size. Near-duplicates of the same type collapse to one.
   - `channels.connected` maps connectors to channels through `CHANNEL_CONNECTORS`: LinkedIn uses `linkedin` or an active LinkedInConnection; X uses `x`; Instagram uses `meta`; YouTube uses `youtube`; Blog uses `wordpress`; Newsletter uses `mailchimp`, `klaviyo` or `hubspot`.
3. **Facts** (`deriveFacts`, `facts.ts`). Each field with a value gets a `meta.facts[path]` record. The record holds `source`, `sourceType`, `confidence`, `trusted`, `inferred`, `capturedAt`, `ageDays`, `freshness`, `conflicted` and an optional `note`.
   - Workspace fields take `sourceType` and `capturedAt` from `preferences.factMeta`.
   - Other tables use their own timestamps.
   - A value borrowed from a fallback source is capped at `medium` and is never trusted.
4. **Issues** (`factIssues`). Adds `stale` and `unverified` entries for important fields and for AI-derived facts, alongside `value_conflict` and `consistency`.
5. **Completeness** (`completenessOf`). Required fields weigh 2, recommended fields 1 and optional fields 0. `score = round(earned / possible × 100)`. A field in a section that was not loaded is not evaluated, so it is unknown rather than missing.
6. **`meta.revision`** is `Company.updatedAt` as an ISO string.

### 3.2 Field registry (`CONTEXT_FIELDS`)

| Field | Requirement | Sources (precedence) | Resolution | Freshness max age |
| --- | --- | --- | --- | --- |
| `identity.name` | required | workspace_profile | precedence | none |
| `identity.description` | required | workspace_profile | precedence | 365 d |
| `audience.marketMode` | required | workspace_profile | precedence | none |
| `audience.stated` | required | workspace_profile → marketing_plan | precedence | 180 d |
| `identity.offerings` | recommended | workspace_profile | precedence | 180 d |
| `identity.industry` | recommended | workspace_profile | precedence | none |
| `identity.website` | recommended | workspace_profile → knowledge_base | precedence | 365 d |
| `objectives.goals` | recommended | workspace_profile → marketing_plan | precedence | 90 d |
| `channels.preferred` | recommended | workspace_profile → marketing_plan | precedence | 365 d |
| `voice.summary` | recommended | brand_voice_profile → onboarding_notes → marketing_plan | layered | 365 d |
| `knowledge.coverage` | recommended | knowledge_base | union | 365 d |
| `identity.visual` | optional | workspace_profile | precedence | 730 d |
| `audience.roleTitles`, `audience.industries` | optional | outreach_targeting ∪ discovery_profiles | union | 180 d |
| `audience.companyStages` | optional | outreach_targeting | union | 180 d |
| `objectives.contentFormats` | optional | workspace_profile | precedence | none |
| `channels.connected` | optional | connections | union | 30 d |
| `market.competitors` | optional | competitor_profiles ∪ trend_config | union | 180 d |
| `market.keywords` | optional | trend_config | precedence | 180 d |
| `market.geo` | optional | trend_config | precedence | none |
| `memory.insights` | optional | marketing_memory | union | 60 d (each insight also 60 d, `INSIGHT_MAX_AGE_DAYS`) |
| `objectives.campaigns` | optional | campaigns | union | 90 d |
| `history.recentContent` | optional | content_history | union | 90 d |
| `history.performance` | optional | analytics | precedence | 45 d |

Freshness (`freshnessOf`):
- `stale` at or past the maximum age.
- `aging` at or past 75% of the maximum age.
- `unknown` when there is no capture date and the field has a maximum age.
- Otherwise `fresh`.

### 3.3 Source types and trust (`SOURCE_TYPE_INFO`)

| Source type | Trusted | Default confidence |
| --- | :-: | --- |
| `user_provided` | ✓ | confirmed |
| `onboarding` | ✓ | confirmed |
| `connected_platform` | ✓ | high |
| `uploaded_document` | ✓ | high |
| `system_generated` | ✓ | high |
| `knowledge_base` | ✗ | medium |
| `marketing_memory` | ✗ | medium |
| `ai_derived` | ✗ | unverified |

Writes record a source type by origin (`ORIGIN_SOURCE_TYPE`):

| Origin | Recorded source type |
| --- | --- |
| `onboarding` | `onboarding` |
| `settings` | `user_provided` |
| `api` | `user_provided` |
| `ai` | `ai_derived` |

### 3.4 Prompt rendering and workflow entry point

`businessContextToPrompt(ctx, workflow)` renders preset blocks in this order: identity, audience or buyer, voice, writing rules, channels, market, campaigns, history, visual, memory, NOT YET KNOWN, RELIABILITY NOTES, knowledge.

Presets (`WORKFLOW_PRESETS`):

| Preset | Identity | Audience | Buyer | Voice | Rules | Channels | Market | Campaigns | History | Visual | Knowledge | Memory |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `content` | ✓ | ✓ | | ✓ | ✓ | | | | | | ✓ | CONTENT_FORMAT, CONTENT_LENGTH, TIMING, TOPIC, HASHTAG |
| `planning` | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ | ✓ | | ✓ | all |
| `advisor` | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ | | | | all |
| `outreach` | ✓ | | | ✓ | | | | | | | ✓ | OUTREACH_APPROACH, TIMING |
| `engagement` | ✓ | | | ✓ | | | | | | | | |
| `image` | ✓ | ✓ | | | | | | | | ✓ | | |
| `qualification` | ✓ | | ✓ | | | | | | | | | |
| `opportunity` | ✓ | ✓ | | | | ✓ | ✓ | ✓ | ✓ | | ✓ | all |
| `recommendation` | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ | ✓ | | ✓ | all |

How the prompt treats facts that are not confirmed:
- An unreviewed AI voice profile is headed "drafted by AI … not yet reviewed", and the company's own notes appear alongside it.
- AI-suggested competitors are listed as "Possibly competitors … never name them as competitors in output".
- AI keywords are labelled unconfirmed.
- Stale memory insights are dropped. At most 12 insights are rendered, and LOW-confidence ones are marked "tentative — small sample".
- The prompt adds a **NOT YET KNOWN** block for required or recommended fields the preset uses that have no value.
- It adds a **RELIABILITY NOTES** block (`contextCaveats`) for used facts that are untrusted or stale.

`getWorkflowContext(companyId, workflow)` loads only the sections in `WORKFLOW_REQUIREMENTS[workflow].sections`. It returns `{ context, prompt, ready, missing[], caveats[] }`. `opportunity` and `recommendation` need `identity.description`, `audience.marketMode` and `audience.stated`. `content`, `planning`, `advisor` and `outreach` need `identity.description`. `engagement`, `image` and `qualification` need nothing.

### 3.5 Writing: `updateBusinessContext(args)`

1. **Shape** (`businessContextPatchSchema`, strict). Only these fields are writable:
   - `identity.{name, website, industry, description, offerings, visual.{logoAssetId, primaryColor, secondaryColor, accentColor}}`
   - `audience.{marketMode, stated}`
   - `objectives.{goals, contentFormats}`
   - `channels.preferred`
   - `voice.{notes, profile}`

   Anything else is rejected with a message naming the module that owns it.

   Caps:

   | Field | Limit |
   | --- | --- |
   | name | 80 |
   | industry | 80 |
   | description | 600 |
   | offerings | 400 |
   | audience (`AUDIENCE_MAX`) | 600 |
   | goals (`GOALS_MAX`) | 600 |
   | voice notes | 2000 |
   | logo asset id | 64 characters, `[A-Za-z0-9_-]` |

   Colours must be hex. Control characters are stripped, and runs of spaces or tabs collapse to one space. Enum lists are de-duplicated. `''` or `null` clears a field.
2. **Rules** (`planBusinessContextWrite`, pure). Rules apply to **changed** values only.

   | Rule | What it enforces |
   | --- | --- |
   | R3 minimum length | name ≥ 2, description ≥ 20, audience ≥ 10 characters |
   | R3 placeholders | Refused in prose fields (description, offerings, industry, audience, goals, voice notes). Matched by the `PLACEHOLDER` regex, for example `n/a`, `tbd`, `test`, `asdf`, `lorem ipsum`, `idk`, `nothing` |
   | R4 required fields | Cannot be cleared. Onboarding must supply all of them |
   | R6 AI writes | An `ai` origin may change only `voice.profile` |
   | R7 no-op | A write that changes nothing is not stored |
   | R8 merge | Only the touched `preferences` sections are replaced; other sections survive |

   Confirmations (`confirm`) are allowed only for `CONFIRMABLE_FIELDS`, never from AI, and only when a value exists. Confirming a value whose source type is already trusted keeps that type; otherwise it becomes `user_provided`. `capturedAt` is kept and `confirmedAt` is stamped. `factMeta[path]` is stamped for every changed field and deleted when a field is cleared.
3. **Transaction** (`business-context-write.service.ts`):
   - Read the row, check `expectedRevision` against `updatedAt` (R9 → 409), and plan the write.
   - R5: a `logoAssetId` must be a `GeneratedAsset` of the same company, or the write gets a 422.
   - Compare-and-swap with `updateMany where { id, updatedAt }`. On a lost race the write is re-planned, up to `MAX_WRITE_ATTEMPTS = 3`. After that it returns 409.
   - Record an audit entry (default `COMPANY_UPDATED`) with `via: 'business-context'`, `origin`, `changedFields`, and `confirmedFields` when there are any.

**Writers that call it:**

| Writer | Call site |
| --- | --- |
| Company create and update (including onboarding) | `server/services/company.service.ts` |
| Audience settings | `app/api/company/audience/route.ts` |
| Brand colours | `app/api/company/brand/route.ts` |
| Content formats | `app/api/company/formats/route.ts` |
| Logo upload | `server/company/logo.service.ts` |
| Brand voice edit and generation (two calls) | `server/content/brand-voice.service.ts` |
| HTTP API | `PATCH /api/business-context` |

The screen-specific adapters in `adapters.ts` translate each form's input into a context patch: `onboardingPatch`, `companyProfilePatch`, `audiencePatch`, `brandPatch` and `formatsPatch`. Each comes with alias maps so errors appear under the form's own field names.

### 3.6 Snapshot

`getContextSnapshot(companyId, { view, strict, force })`:

1. **Check the stored row.** Reads the stored `BusinessContextSnapshot` and computes a **source stamp**: a SHA-256 hash truncated to 24 hex characters. The stamp combines the latest change time and row count of 13 sources:
   - Company
   - OutreachConfig
   - active DiscoveryProfiles
   - CompetitorProfiles
   - CompanyTrendConfig
   - MarketingPlans
   - CONNECTED Connections
   - ACTIVE LinkedInConnection
   - KnowledgeChunks
   - active MarketingMemory
   - ACTIVE/PAUSED Campaigns
   - PUBLISHED/APPROVED ContentDrafts
   - AnalyticsReports
2. **Decide whether to rebuild** (`refreshReason`). The reasons are checked in order:

   | Reason | When |
   | --- | --- |
   | `forced` | The caller passed `force` |
   | `missing` | No snapshot is stored |
   | `version` | `SNAPSHOT_VERSION` (2) differs from the stored version |
   | `invalidated` | `invalidatedAt` is set |
   | `sources_changed` | The source stamp differs |
   | `expired` | Older than 6 h (`SNAPSHOT_TTL_MS`) |

   A stored payload that fails to parse is also rebuilt, with reason `version`.
3. **Rebuild.** Loads the full context, retrieves up to 12 knowledge passages using the business's own offerings, description and name as the query, runs `buildSnapshot`, and upserts the row.
4. **Cut the view.** `viewSnapshot(full, view, strict)` returns the requested view, and `snapshotToPrompt` renders it.

**What goes where.** Only trusted, non-stale facts go into the main sections. Untrusted or stale facts go into `assumptions`, or into `omitted` in strict mode.

**Size caps** (`SNAPSHOT_LIMITS`):

| Item | Cap |
| --- | --- |
| tags | 6 |
| stages | 4 |
| insights | 8 |
| competitors | 8 |
| keywords | 10 |
| highlights | 3 |
| recentTopics | 8 |
| excerptChars | 280 |
| voiceList | 6 |

**Views:**

| View | Sections |
| --- | --- |
| `full`, `recommendation`, `planning` | all 9 sections (business, products, audience, goals, voice, channels, learning, market, history) |
| `content` | all except market |
| `opportunity` | all except voice |
| `outreach` | business, products, voice, learning |
| `engagement` | business, voice |

**Fingerprint.** A SHA-256 hash, 16 hex characters, of the snapshot content. It excludes `fingerprint`, `generatedAt`, `meta`, `view`, `strict` and every `ageDays`, so an unchanged business keeps the same fingerprint across rebuilds.

`invalidateContextSnapshot` is best-effort. `server/memory/memory.service.ts` calls it, because editing a memory insight's text does not change any timestamp the stamp sees.

### 3.7 Questions

**Gap detection** (`detectGaps`) produces gaps with key `<kind>:<field>`.
- Kinds: `missing`, `conflict`, `stale`, `unverified`.
- Priority comes from the field's requirement: required → `critical`, recommended → `important`, optional → `optional`.
- Only some fields produce gaps:
  - **Askable here:** `identity.description`, `identity.offerings`, `identity.industry`, `identity.website`, `audience.marketMode`, `audience.stated`, `objectives.goals`, `channels.preferred`, and `voice.summary` (answered through `voice.notes`).
  - **Linked to another page:** `knowledge.coverage`, `market.competitors` and `identity.visual`.
- Values borrowed from a fallback (`inferred`) are asked for as `missing`.
- Gaps are sorted by priority, then kind: missing, conflict, stale, unverified.

**`QUESTION_RULES`:**

| Rule | Value |
| --- | --- |
| A showing counts as asked at most once per | 12 h |
| "Not now" snoozes for | 7 days |
| Auto-rest starts after | 3 asks without an answer |
| Auto-rest lasts | 3 days (critical), 14 days (important or optional) |
| Dismissing a critical question | Refused (422) |

Each request syncs the stored history: a question whose gap is gone becomes `RESOLVED`, and a question whose gap returns is reopened with its count reset.

**Answering** (`answerQuestion`):
1. Re-detect the gap. If it is already filled, the answer is refused with 409. Link questions get 422.
2. A `confirm` answer to a `missing` gap gets 422.
3. `answerToUpdate` turns the answer into a patch or a confirmation, which goes through `updateBusinessContext` with `origin: 'settings'` and audit metadata `{ question: key }`.
4. The question row is marked `ANSWERED`.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/business/page.tsx` | About my business: loads context, membership, questions; `?ask=` focus |
| Component | `components/dashboard/business/business-context-view.tsx` | Completeness, attention list, sectioned fact rows, inline editors, confirm, 409 banner |
| Component | `components/dashboard/business/aura-questions.tsx` | Question card: answer, confirm, snooze, dismiss, link-out |
| API | `app/api/business-context/route.ts` | `GET` context, `PATCH` update/confirm |
| API | `app/api/business-context/snapshot/route.ts` | `GET` snapshot view, `POST` forced rebuild |
| API | `app/api/business-context/questions/route.ts` | `GET` questions, `POST` answer / snooze / dismiss |
| Lib (pure) | `lib/business-context.ts` | Schema, sources, source types, confidence, freshness rules, field registry, `CHANNEL_CONNECTORS` |
| Lib (pure) | `lib/business-context-snapshot.ts` | Snapshot schema, sections, views, limits, TTL, refresh reasons |
| Lib (pure) | `lib/business-context-questions.ts` | Gap detection, question wording, answer schema, answer → update |
| Lib (pure) | `lib/business-context-ui.ts` | `EDITABLE_FIELDS`, display values, source/freshness indicators, `confirmTarget`, `attentionItems` |
| Validation | `lib/validations/business-context.ts` | Patch schema, update body schema, `UPDATE_ORIGINS`, `BusinessContextUpdateError` (422), `BusinessContextConflictError` (409) |
| Service | `server/business-context/business-context.service.ts` | `getBusinessContext`, `businessContextToPrompt`, `WORKFLOW_PRESETS`, `WORKFLOW_REQUIREMENTS`, `getWorkflowContext`, `contextCaveats`, `unknownFields`, `toAudienceProfile` |
| Service (pure) | `server/business-context/build.ts` | `buildBusinessContext`, resolver, `mapMemory`, competitor merge, `readPlanDuplicates`, `fieldPresence`, `isEvaluable`, completeness |
| Service (pure) | `server/business-context/facts.ts` | `deriveFacts`, `factIssues`, `readStoredFactMeta`, `trendSourceType` |
| Service (pure) | `server/business-context/update.ts` | `planBusinessContextWrite` (R1–R9), `CONFIRMABLE_FIELDS`, `AI_WRITABLE_FIELDS`, `ORIGIN_SOURCE_TYPE` |
| Service | `server/business-context/business-context-write.service.ts` | `updateBusinessContext`: transaction, CAS retry, R5, audit; `toCompanyData` |
| Service | `server/business-context/adapters.ts` | Screen input → context patch, plus error alias maps |
| Service (pure) | `server/business-context/snapshot.ts` | `buildSnapshot`, `viewSnapshot`, `fingerprintOf`, `snapshotToPrompt` |
| Service | `server/business-context/snapshot.service.ts` | `getContextSnapshot`, `computeSourceStamp`, `refreshReason`, `invalidateContextSnapshot` |
| Service | `server/business-context/questions.service.ts` | `getQuestions`, `answerQuestion`, `setQuestionAside`, `isAskable`, `QUESTION_RULES` |
| Service | `server/business-context/coverage.ts` | `checkCoverage`, `auditContextCoverage`, `INTENTIONALLY_UNMAPPED_TABLES` |
| Script | `scripts/verify-context-sources.ts` | Runs the coverage audit for every workspace; any LOST value fails |
| Tests | `tests/business-context.test.ts`, `tests/business-context-service.test.ts`, `tests/business-facts.test.ts`, `tests/context-snapshot.test.ts`, `tests/context-questions.test.tsx`, `tests/context-sources.test.ts`, `tests/about-my-business.test.tsx` | See §10 |

## 5. Data model

**Owned models** (`prisma/schema.prisma`):

| Model | Key fields | Notes |
| --- | --- | --- |
| `BusinessContextSnapshot` | `id`, `companyId` (unique), `version` Int, `fingerprint`, `sourceStamp`, `payload` Json, `generatedAt`, `invalidatedAt?` | One per workspace, the full view; cascade-deleted with `Company`. Migration `20261001090000_business_context_snapshot`. |
| `BusinessContextQuestion` | `id`, `companyId`, `questionKey`, `status` (`ContextQuestionStatus`), `timesAsked`, `lastAskedAt?`, `snoozedUntil?`, `answeredAt?`, `answeredById?`, `createdAt`, `updatedAt` | `@@unique([companyId, questionKey])`, `@@index([companyId, status])`. Migration `20261002090000_business_context_questions`. |
| enum `ContextQuestionStatus` | `OPEN`, `ANSWERED`, `SNOOZED`, `DISMISSED`, `RESOLVED` | |

**Stored on `Company`.** These are the writable business fields:
- Columns: `name`, `website`, `industry`, `brandVoiceNotes`, `brandVoiceProfile` (Json), `logoUrl` (legacy avatar, read only).
- `preferences` Json, with these keys:

  | Key | Contents |
  | --- | --- |
  | `business` | `description`, `offerings` |
  | `marketingProfile` | `marketMode`, `audience`, `goals`, `channels` |
  | `brand` | `logoAssetId`, `primaryColor`, `secondaryColor`, `accentColor` |
  | `contentFormats` | `enabled[]` |
  | `factMeta` | Map from field path to `{ sourceType, capturedAt, confirmedAt? }` |

- `updatedAt` serves as `meta.revision`.

**Read only** (owned by other features): `OutreachConfig`, `DiscoveryProfile`, `CompetitorProfile`, `CompanyTrendConfig`, `MarketingPlan`, `Campaign`, `Connection`, `LinkedInConnection`, `KnowledgeSource`, `KnowledgeChunk`, `MarketingMemory`, `ContentDraft`, `AnalyticsReport` and `AuditLog`. `AuditLog` is written for each change.

**Downstream references:**
- `Execution.businessContextRevision` records the context revision behind an execution, for traceability.
- The value `BUSINESS_CONTEXT` appears in the enums `OpportunitySource`, `OpportunitySignalKind` and `SignalSource`.

## 6. API endpoints

All routes are under `/api/business-context`, set `dynamic = 'force-dynamic'`, and are scoped to the caller's active workspace through `requireActiveCompany()`. See also [Internal API](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
| --- | --- | --- | --- |
| GET | `/api/business-context` | Resolved context (`{ context }`) with provenance, facts, issues, completeness and `meta.revision`. Loads no knowledge passages. | Any workspace member |
| PATCH | `/api/business-context` | Body `{ patch, expectedRevision?, confirm? }` (strict; `expectedRevision` ≤ 40 characters; `confirm` ≤ 20 paths of ≤ 60 characters). Returns `{ changed, confirmed, context }`. 422 for shape or rule refusals with per-field `details`; 409 for a stale revision. | `company:update` (OWNER, ADMIN), else 403 |
| GET | `/api/business-context/snapshot?view=&strict=` | Snapshot view (default `full`). `strict` accepts `1`/`0`/`true`/`false`. Returns `{ snapshot, prompt, status: 'current' \| 'rebuilt', reason? }`. | Any workspace member |
| POST | `/api/business-context/snapshot` | Body `{ view?, strict? }`. Forces a rebuild. | `company:update`, else 403 |
| GET | `/api/business-context/questions?workflow=&limit=&markAsked=` | Questions to ask now. `limit` 1–20 (default 3). `workflow` is one of the `WORKFLOW_PRESETS` keys. Returns `{ questions, openCount, criticalCount }`. | Any workspace member |
| POST | `/api/business-context/questions` | Body `{ key (≤ 80), action: 'answer', answer: { value } \| { confirm: true } }` or `{ key, action: 'snooze' \| 'dismiss' }`. Returns `{ changed, confirmed, ...nextQuestions }`. | `company:update`, else 403 |

## 7. External services

None. Knowledge retrieval (`server/knowledge/retrieve.ts`) is database-only, and no module in this feature reads environment variables. See [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md) for the platform-wide list (database connection).

## 8. Background jobs & cron

None. The snapshot is rebuilt lazily on read, when the source stamp changes, the 6-hour TTL passes, it is invalidated, or a POST forces it. Question history syncs on every `getQuestions` call.

## 9. Security & permissions

- **Workspace scoping.** Every route resolves the company with `requireActiveCompany()`. The services always filter by `companyId`, including the snapshot and question upserts and the R5 logo-asset check (`generatedAsset.findFirst({ id, companyId })`).
- **RBAC.** Writes need `company:update`: PATCH context, POST questions and POST snapshot. Only OWNER and ADMIN have it (`lib/rbac.ts`). Reads are open to all members, including VIEWER.
- **Validation.**
  - Strict Zod schemas reject unknown and module-owned fields.
  - Text is cleaned (control characters stripped, spaces collapsed).
  - Rule refusals are collected and returned all at once.
  - AI-origin writes cannot change stated facts or confirm anything (R6).
- **Concurrency.** `expectedRevision` provides optimistic concurrency, and the compare-and-swap with 3 attempts stops concurrent writers to the shared `preferences` bag from erasing each other.
- **Audit.** Each real change writes an audit row with `changedFields` and `origin`. A no-op is not audited.
- `pnpm verify:access` exercises these routes. It checks cross-workspace forgery on GET context, snapshot and questions, and that a VIEWER is refused on PATCH context, POST questions and POST snapshot.

## 10. Testing

| Test | Covers |
| --- | --- |
| `tests/business-context.test.ts` | Model, registry, builder resolution and conflicts |
| `tests/business-context-service.test.ts` | Read service, prompt presets, update rules and write service |
| `tests/business-facts.test.ts` | Source types, confidence, freshness, fact issues, confirmation |
| `tests/context-snapshot.test.ts` | Snapshot build, views, strict mode, fingerprint, refresh reasons |
| `tests/context-questions.test.tsx` | Gap detection, question rules, answers, question UI |
| `tests/context-sources.test.ts` | Coverage audit (`checkCoverage`) |
| `tests/about-my-business.test.tsx` | About my business UI helpers and components |

Run them with `pnpm test` (Vitest). These scripts need a database:

| Script | What it checks |
| --- | --- |
| `pnpm verify:context-sources` | No stored business value is LOST |
| `pnpm verify:access` | Workspace isolation and RBAC on all three routes |
| `pnpm verify:flow` | Context, update, snapshot refresh and questions end to end |
| `pnpm verify:engine` | Snapshot refresh after `updateBusinessContext` |
| `pnpm verify:readiness` | Questions |
| `pnpm verify:sprint8` | Reads the context |
| `pnpm verify:trace` | `businessContextRevision` stored on generated output |

## 11. Configuration & limits

No environment variables. These constants are fixed in code:

| Constant | Value | Where |
| --- | --- | --- |
| `BUSINESS_CONTEXT_VERSION` | 2 | `lib/business-context.ts` |
| `SNAPSHOT_VERSION` | 2 | `lib/business-context-snapshot.ts` |
| `SNAPSHOT_TTL_MS` | 6 h | `lib/business-context-snapshot.ts` |
| `SNAPSHOT_LIMITS` | tags 6, stages 4, insights 8, competitors 8, keywords 10, highlights 3, recentTopics 8, excerptChars 280, voiceList 6 | `lib/business-context-snapshot.ts` |
| Snapshot product-evidence retrieval | 12 passages | `snapshot.service.ts` |
| Default `knowledgeLimit` | 6 | `business-context.service.ts` |
| Load caps | 50 memory rows, 5 campaigns, 3 discovery profiles, 10 recent drafts (90 days) | `business-context.service.ts` |
| Memory insights rendered in a prompt | 12 | `business-context.service.ts` |
| Market keywords rendered in a prompt | 12 | `business-context.service.ts` |
| Competitor notes | 300 characters | `build.ts` |
| `MAX_WRITE_ATTEMPTS` | 3 | write service |
| `QUESTION_RULES` | 12 h cooldown, 7-day snooze, rest after 3 asks for 3 / 14 days | `questions.service.ts` |
| Questions on the page | 3 | `page.tsx` |
| Questions per API call | 1–20 | questions route |
| Patch caps | See §3.5 | `lib/validations/business-context.ts` |

## 12. Known limitations & future work

- **Module-owned fields are read-only here.** Buyer roles, industries and stages, connected channels, competitors, keywords, geo, knowledge and memory are edited in their own modules. The page shows them read-only or links out.
- **A memory text edit is invisible to the source stamp.** `MarketingMemory` has no `updatedAt`, so an in-place edit relies on `invalidateContextSnapshot`. That call is best-effort, and the 6-hour TTL bounds a missed invalidation.
- **Snapshots can be briefly late.** The source stamp is taken before building, so a source change during a build is only picked up on the next read.
- **Old values can have unknown freshness.** Values saved before `factMeta` existed have no capture date. Their freshness is `unknown` for fields that have a maximum age.
- **The knowledge-base website fallback needs exactly one synced site.** With several WEBSITE sources, none is used.
- **Old direct writers remain.** `saveBrandAssets`, `saveMarketingProfile` and `saveContentFormats` are deprecated per [BUSINESS-CONTEXT-MODEL.md](../../../BUSINESS-CONTEXT-MODEL.md) §8.

## 13. Related documents

- [BUSINESS-CONTEXT-MODEL.md](../../../BUSINESS-CONTEXT-MODEL.md): full model, rules, snapshot and questions
- [BUSINESS-CONTEXT-SOURCES-AUDIT.md](../../../BUSINESS-CONTEXT-SOURCES-AUDIT.md): field-by-field source audit and module migration
- [GENERATION-CONTEXT.md](../../../GENERATION-CONTEXT.md), [RECOMMENDATION-CONTEXT-HANDOFF.md](../../../RECOMMENDATION-CONTEXT-HANDOFF.md), [TRACEABILITY.md](../../../TRACEABILITY.md), [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md)
- Architecture: [02-ARCHITECTURE.md](02-ARCHITECTURE.md)
- Sibling features:
  - [Onboarding & guided setup](../03-onboarding-and-guided-setup/)
  - [Knowledge base & brand voice](../04-knowledge-base-and-brand-voice/)
  - [Trend insights](../06-trend-insights/)
  - [Competitor intelligence](../07-competitor-intelligence/)
  - [Signals & opportunities](../08-signals-and-opportunities/)
  - [Recommendations & Aura Suggests](../09-recommendations-and-aura-suggests/)
  - [Marketing memory & analytics](../18-marketing-memory-and-analytics/)
  - [Connections & connectors](../19-connections-and-connectors/)
  - [AI layer](../23-ai-layer/)
