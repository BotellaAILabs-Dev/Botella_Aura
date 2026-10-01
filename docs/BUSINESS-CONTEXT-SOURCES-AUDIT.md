# Business Context — Source Audit and Mapping

This document audits every place Aura already stores business information. It
records how each field maps into the Business Context layer
([BUSINESS-CONTEXT-MODEL.md](BUSINESS-CONTEXT-MODEL.md)), what can't or
shouldn't be mapped, where data is duplicated, and what migration and
compatibility need.

**Check it any time:** `pnpm verify:context-sources` checks every workspace in
the database. Every stored value that has data must be **reachable** in the
context, **superseded** by a higher-precedence source (and recorded as a
conflict), or **intentionally** unmapped with a stated reason. Anything else is
reported as **LOST** and fails the run. Current result against the local
database: 22 values checked, **0 lost**.

---

## 1. Audit and field mapping

**Notation.** "→ fallback" means the value is used only when the primary source
is empty, and is marked `inferred`.

### Onboarding and workspace profile — `Company` and `Company.preferences`

| Stored field | Written by | Context field | Status |
| --- | --- | --- | --- |
| `Company.name` | Onboarding, Settings | `identity.name` | mapped |
| `Company.website` | Onboarding, Settings | `identity.website` | mapped |
| `Company.industry` | Onboarding, Settings | `identity.industry` | mapped |
| `preferences.business.description` | Onboarding, Settings | `identity.description` | mapped |
| `preferences.business.offerings` | Onboarding, Settings | `identity.offerings` | mapped |
| `preferences.marketingProfile.marketMode` | Onboarding, Audience settings | `audience.marketMode` | mapped |
| `preferences.marketingProfile.audience` | Onboarding, Audience settings | `audience.stated` | mapped |
| `preferences.marketingProfile.goals` | Onboarding, Audience settings | `objectives.goals` | mapped |
| `preferences.marketingProfile.channels` | Audience settings | `channels.preferred` | mapped |
| `preferences.brand.*` (logo asset, 3 colours) | Brand settings, logo upload | `identity.visual` | mapped |
| `preferences.contentFormats.enabled` | Formats settings | `objectives.contentFormats` | mapped |
| `preferences.factMeta` | Business Context write service | `meta.facts` (source, capture date) | mapped |
| `Company.logoUrl` | Legacy (Sprint 1) | `identity.visual.logoUrl` | **newly mapped** (fallback when no logo was uploaded) |
| `preferences.autopilot` | Autopilot settings | — | intentional: automation settings, not a business fact |
| `preferences.tone`, `preferences.emojiUsage` | Seed scripts only (never the app) | — | intentional: legacy seed keys; tone and emoji live in the voice notes and profile |
| `Company.onboardedAt`, `slug` | System | — | intentional: not business facts |

### Brand voice

| Stored field | Written by | Context field | Status |
| --- | --- | --- | --- |
| `Company.brandVoiceNotes` | Onboarding (including tone chips), Settings | `voice.notes`; `voice.summary` fallback | mapped |
| `Company.brandVoiceProfile` | AI generation, brand voice card | `voice.profile`; its summary is `voice.summary` | mapped (AI-derived until a person confirms it) |
| `MarketingPlan.inputs.brandGuidelines` | Planner form | `voice.planGuidelines`; last fallback for `voice.summary` | mapped |
| Knowledge documents in category `BRAND_GUIDELINES` | Knowledge base | retrieved passages, labelled "brand guidelines" | mapped |

### Knowledge base

| Stored field | Context field | Status |
| --- | --- | --- |
| `KnowledgeChunk` counts by category and source type | `knowledge.covered` / `missing` / `totalChunks` / `uncategorisedChunks` | mapped |
| `KnowledgeChunk` content | `knowledge.passages` (per-query retrieval); snapshot product highlights | mapped |
| `KnowledgeSource` URLs of type WEBSITE | `knowledge.websiteUrls`; → fallback for `identity.website` | mapped |
| `KnowledgeSource.status` / `error` / `lastSyncedAt` | — | intentional: sync bookkeeping |

### Marketing memory

| Stored field | Context field | Status |
| --- | --- | --- |
| Active `MarketingMemory` rows | `memory.insights` (type, insight, confidence, sample size, freshness) | mapped |
| `supportingDataSummary.editedByUser` | `memory.insights[].editedByUser` (ranked first, counts as confirmed) | mapped |
| `supportingDataSummary.status = 'insufficient'` | — | intentional: a dashboard message, not a pattern |
| Dismissed rows (`isActive = false`) | — | intentional: dismissed by the user |

### Targeting, market and channels

| Stored field | Context field | Status |
| --- | --- | --- |
| `OutreachConfig.roleTitles` / `industries` / `companyStages` | `audience.roleTitles` / `industries` / `companyStages` | mapped |
| `OutreachConfig.enabledSources` | — | intentional: where lead signals are fetched from |
| `DiscoveryProfile.criteria` (3 newest active) | `audience.roleTitles`, `audience.industries` | mapped |
| `DiscoveryProfile` beyond the 3 newest | — | intentional: still drives lead discovery; not used to describe the audience (unchanged rule) |
| `CompetitorProfile.name`, `url`, `trackingEnabled` | `market.competitors[]` | mapped |
| `CompetitorProfile.notes` | `market.competitors[].notes` | **newly mapped** |
| `CompetitorProfile.pricingUrl`, `linkedInUrl`, `githubOrg` | — | intentional: tracking configuration |
| `CompanyTrendConfig.keywords`, `competitorNames`, geo, language | `market.keywords`, `market.competitors`, `market.geo` | mapped |
| `CompanyTrendConfig.subreddits`, `rssFeeds`, `enabledSources`, `timeRangeDays` | — | intentional: where and how far back the trend job looks |
| `Connection` (CONNECTED) and `LinkedInConnection` (ACTIVE) | `channels.connected` | mapped |
| Connectors that aren't publishing channels (GA4, Search Console, CRMs, storage, design tools) | — | intentional: not channels |

### Plans, campaigns, analytics and history

| Stored field | Context field | Status |
| --- | --- | --- |
| `MarketingPlan.inputs` (audience, goals, channels) | → fallback for `audience.stated`, `objectives.goals`, `channels.preferred` | mapped |
| `MarketingPlan.inputs.topics`, `campaignObjectives`, `postsPerWeek`; `payload` | — | intentional: one month's plan, not a standing fact |
| `Campaign` (ACTIVE / PAUSED): name, goal, `targetAudience`, themes, end date | `objectives.campaigns` | **newly mapped** |
| `ContentDraft` (PUBLISHED or APPROVED, last 90 days): titles | `history.recentContent` | **newly mapped** |
| `AnalyticsReport` (latest): numeric metrics and period | `history.performance` | **newly mapped** |
| `PerformanceSnapshot` | — | intentional: raw per-post metrics, summarised by memory and analytics |

### Tables that are intentionally not context

| Table | Why |
| --- | --- |
| TrendDigest, AdvisorReport, CompetitorReport, WorkspaceBriefing | AI-written outputs built *from* the context; feeding them back in would be circular. |
| IntelligenceSnapshot | A score computed from the context and activity. |
| CompetitorSnapshot | Raw change tracking; summarised by the competitor report. |
| Lead, OutreachMessage, EngagementTarget | Individual records and work queues. Who to target is already in `audience`, and what works reaches the context through memory. |
| GeneratedAsset | Images; the logo is mapped through `identity.visual`. |
| Subscription | Billing. |

---

## 2. Fields that can't be mapped today

| Field | Why not | What would make it mappable |
| --- | --- | --- |
| Whether a legacy (pre-capture-date) value was set at onboarding or later in Settings | Both wrote the same columns, and no capture metadata existed before the source/confidence work. | Nothing retroactive. These values show source `user_provided` and freshness `unknown` until next saved or confirmed. |
| Whether a pre-existing brand voice profile was ever reviewed | The profile JSON never recorded it. The audit log has `BRAND_VOICE_UPDATED` entries, but they can't be tied to the current profile version. | Saving or confirming the voice card once (it now confirms automatically). |
| Whether pre-existing trend keywords were reviewed after AI seeding, beyond "the settings were saved at least once" | Saving the trend form re-saves every keyword; there's no per-keyword record. | Per-keyword confirmation in the trend settings UI. |
| Edits to a memory insight's text, for snapshot freshness | `MarketingMemory` has no `updatedAt`. | Handled explicitly: `updateMemoryInsight` invalidates the snapshot. Adding an `updatedAt` column would make it automatic. |
| Real social-platform performance (reach, impressions) | LinkedIn analytics aren't available at the current API scope. | An approved analytics scope or a connected analytics provider. |
| A business's pricing, customers or case studies as structured fields | Never stored as fields; they appear only inside uploaded documents. | Retrieved as passages today. Structured fields would need new onboarding or settings questions. |

---

## 3. Duplicate data storage

| Fact | Where it's duplicated | How the context resolves it |
| --- | --- | --- |
| Logo | `Company.logoUrl` (legacy avatar) ↔ `preferences.brand.logoAssetId` (uploaded) | The uploaded asset wins; `logoUrl` is used only when none was uploaded. |
| Brand voice | `brandVoiceNotes` ↔ `brandVoiceProfile` ↔ plan `brandGuidelines` ↔ BRAND_GUIDELINES documents | Layered: a confirmed profile, then the notes, then plan guidelines. Documents are retrieved evidence. |
| Audience | Audience settings ↔ plan `audience` ↔ `Campaign.targetAudience` ↔ OutreachConfig ↔ DiscoveryProfile | Settings win, and the plan is a fallback. Campaign audiences are kept per campaign, and targeting tags are merged. |
| Goals | Audience settings ↔ plan `businessGoals` ↔ `Campaign.goal` | Settings win and the plan is a fallback; each campaign keeps its own goal. |
| Channels | Audience settings ↔ plan `channels` | Settings win; the plan is a fallback. |
| Competitors | `CompetitorProfile` ↔ `CompanyTrendConfig.competitorNames` | Merged; tracked profiles are confirmed, and AI-seeded watch-list names are assumptions. |
| Industry | `Company.industry` ↔ `OutreachConfig.industries` | Not a duplicate: the company's own industry vs. the industries it sells into. |
| Tone and emoji | `preferences.tone` / `emojiUsage` (seed only) ↔ voice notes and profile | The seed keys are ignored; the voice is authoritative. |

Every value that loses a precedence contest is recorded in `meta.issues` as a
`value_conflict`, so a person can see and fix it.

---

## 4. Migration and compatibility requirements

1. **Database migrations.** One additive migration exists so far,
   `20261001090000_business_context_snapshot`, from the snapshot ticket. This
   ticket adds none: every new mapping reads existing columns.
2. **Context and snapshot versions.** `BUSINESS_CONTEXT_VERSION` 1 → 2 and
   `SNAPSHOT_VERSION` 1 → 2 (new `history` and campaign fields). A stored
   snapshot with the old version is rebuilt automatically on its next read
   (reason `version`), with no backfill step.
3. **Legacy values.** Values written before capture dates read as
   `user_provided` with freshness `unknown`. Existing voice profiles read as
   unreviewed AI drafts until confirmed. Nothing is rewritten in bulk; values
   upgrade as people save or confirm them.
4. **Corrupt or old-format data.** Every read of `preferences`, voice
   profiles, plan inputs and stored snapshots goes through a `safeParse` or a
   defensive reader. A bad value is dropped from the context (and reported by
   the coverage check), never thrown.
5. **Deprecated writers.** `saveBrandAssets`, `saveMarketingProfile` and
   `saveContentFormats` bypass the update rules. Only
   `scripts/verify-onboarding.ts` still calls them; new code must use
   `updateBusinessContext`.
6. **Behaviour changes in prompts.**
   - Workflows now see unconfirmed and stale facts labelled as such, and the
     advisor, planner and recommendation workflows also see running campaigns
     and recent content.
   - The content generator's `PROMPT_VERSION` is now `s6.business-context`, and
     each draft records the `contextRevision` it was written from.
7. **Before release.** Run `pnpm verify:context-sources` against a copy of
   production data. It must report 0 lost.

---

## 5. Modules connected to the context service

| Module | Before | Now |
| --- | --- | --- |
| Content generator, draft refine | `getAudienceProfile` + `getBusinessProfile` + `getActiveMemories` + raw voice, hand-assembled | `getBusinessContext` + the `content` preset |
| Outreach drafting | `getBusinessProfile` + raw voice + memory, hand-assembled | `getBusinessContext` + the `outreach` preset |
| Engagement comments | `getBusinessProfile` + raw voice | `getBusinessContext` + the `engagement` preset |
| Image prompts | `getBusinessProfile` + `getAudienceProfile` | Business, audience and palette read from `getBusinessContext` (visual rendering kept) |
| Advisor | `getAudienceProfile` + `getBusinessProfile` + a second voice read + raw `brandVoiceNotes` fallback | `getBusinessContext`: identity, audience and channels block, resolved `voice.summary`, `objectives.goals` |
| Trend digest | Raw `brandVoiceNotes` in both prompts | Identity block and resolved `voice.summary` from the context |
| Trend seeding | Name, industry and raw `brandVoiceNotes` | Identity and buyer facts from the context (better-grounded keyword and competitor guesses) |
| Campaign planner, monthly planner | Already on `getBrandContext` | Unchanged (it reads from the context) |
| Lead qualification | Already on the `qualification` preset | Unchanged |
| Onboarding and all settings screens (writes) | Already on `updateBusinessContext` | Unchanged |

**Still reading raw columns, by design:**
- **Intelligence foundations score and brand-consistency analysis.** These check
  whether setup steps *exist* (website set, voice profile generated) and analyse
  drafts against the profile. They're dashboard scoring, not prompt context.
- **Onboarding checklist.** Step completion is derived from the stored data.
- **Onboarding preview.** It runs before a workspace exists, on the wizard's
  unsaved answers.
