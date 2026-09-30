# Unified Business Context Data Model

One structure for everything Aura knows about a workspace's business, used by
onboarding, AI workflows, recommendations, content generation, analytics and
memory.

| Piece | Where |
| --- | --- |
| Schema, field registry, source list | [`lib/business-context.ts`](../lib/business-context.ts) (pure, client-safe) |
| Mapping + conflict resolution | [`server/business-context/build.ts`](../server/business-context/build.ts) (pure) |
| Retrieval + prompt rendering | [`server/business-context/business-context.service.ts`](../server/business-context/business-context.service.ts) |
| Update: patch schema + errors | [`lib/validations/business-context.ts`](../lib/validations/business-context.ts) (pure, client-safe) |
| Update rules | [`server/business-context/update.ts`](../server/business-context/update.ts) (pure) |
| Update: transactional write | [`server/business-context/business-context-write.service.ts`](../server/business-context/business-context-write.service.ts) |
| Screen → patch adapters | [`server/business-context/adapters.ts`](../server/business-context/adapters.ts) |
| HTTP | `GET` and `PATCH /api/business-context` |
| Tests | [`tests/business-context.test.ts`](../tests/business-context.test.ts), [`tests/business-context-service.test.ts`](../tests/business-context-service.test.ts) |

---

## 1. Why

The same business facts were stored in several places and each AI workflow
read its own subset:

- **Brand voice** lived in `Company.brandVoiceNotes`, `Company.brandVoiceProfile`
  and every plan's `brandGuidelines`. Trends and the advisor read the raw notes,
  content read the profile, and lead scoring passed the *tone* notes to the model
  as the description of the company.
- **Audience** lived in audience settings, `OutreachConfig`, `DiscoveryProfile`
  and every plan's `audience`.
- **Competitors** lived in `CompetitorProfile` and `CompanyTrendConfig.competitorNames`.
- **Goals and channels** lived in audience settings and every plan's inputs.

No module had a definition of what a complete business profile is.

---

## 2. Interface for AI workflows

New workflows should start from `getWorkflowContext`. One call returns the
context, the rendered preamble, and whether the workflow has enough to run:

```ts
import { getWorkflowContext } from '@/server/business-context/business-context.service';

const wf = await getWorkflowContext(companyId, 'opportunity', { query });
if (!wf?.ready) return emptyState(wf?.missing); // [{ field, label, href }]
await model({ system: wf.prompt /* ... */ });
```

Each workflow in `WORKFLOW_REQUIREMENTS` declares the sections it loads (so it
pays only for what its preset renders) and the fields it cannot run without:

| Workflow | Loads | Refuses to run without |
| --- | --- | --- |
| `opportunity`, `recommendation` | targeting, market, connections, knowledge, memory, plan | description, market mode, stated audience |
| `content`, `planning`, `advisor`, `outreach` | what their preset renders | description |
| `engagement`, `image`, `qualification` | what their preset renders | nothing |

The lower-level pair is still available when a workflow needs control:

```ts
import {
  getBusinessContext,
  businessContextToPrompt,
} from '@/server/business-context/business-context.service';

const ctx = await getBusinessContext(companyId, { query: topic });
const preamble = businessContextToPrompt(ctx, 'content');
```

`getBusinessContext(companyId, options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `sections` | all | Optional sections to load: `targeting`, `market`, `plan`, `connections`, `knowledge`, `memory`. Identity, audience settings, objectives, preferred channels and voice are always loaded because they come from the `Company` row. |
| `query` | none | Retrieve knowledge passages about this. Omitted means no retrieval. |
| `knowledgeLimit` | 6 | Number of passages to retrieve. |

`businessContextToPrompt(ctx, workflow)` renders with a named preset or a
custom option set:

| Preset | Identity | Audience | Buyer facts | Voice | Writing rules | Channels | Market | Visual | Knowledge | Memory |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `content` | ✓ | ✓ | | ✓ | ✓ | | | | ✓ | format, length, timing, topic, hashtag |
| `planning` | ✓ | ✓ | | ✓ | | ✓ | ✓ | | ✓ | all |
| `advisor` | ✓ | ✓ | | ✓ | | ✓ | ✓ | | | all |
| `outreach` | ✓ | | | ✓ | | | | | ✓ | outreach approach, timing |
| `engagement` | ✓ | | | ✓ | | | | | | |
| `image` | ✓ | ✓ | | | | | | ✓ | | |
| `qualification` | ✓ | | ✓ | | | | | | | |
| `opportunity` | ✓ | ✓ | | | | ✓ | ✓ | | ✓ | all |
| `recommendation` | ✓ | ✓ | | ✓ | | ✓ | ✓ | | ✓ | all |

Outreach and engagement leave out the audience block because they address one
named person or reply to someone else's post. Qualification gets the buyer as
plain facts, not as writing instructions.

`getBrandContext` (the earlier, partial interface) is now a projection of
`getBusinessContext`, so its callers use the same sources and rules.

---

## 3. Schema

`BusinessContext` (version 1). Every section is always present, with empty
defaults when there is no data or the section was not loaded.

| Entity | Fields |
| --- | --- |
| `identity` | `companyId`, `name`, `website`, `industry`, `description`, `offerings`, `visual` (logo asset, primary/secondary/accent colour) |
| `audience` | `marketMode` (B2B/B2C), `stated`, `roleTitles[]`, `industries[]`, `companyStages[]` |
| `objectives` | `goals`, `contentFormats[]` (empty = all formats) |
| `channels` | `preferred[]` (where it publishes; drives planning), `connected[]` (where Aura can act; drives execution) |
| `voice` | `profile` (structured brand voice), `notes` (raw onboarding notes), `planGuidelines`, `summary` (resolved one-liner) |
| `market` | `competitors[]` (`name`, `url`, `tracked`, `source`), `keywords[]`, `geo` (country, region, city, language) |
| `knowledge` | `totalChunks`, `covered[]`, `missing[]`, `uncategorisedChunks`, `websiteUrls[]`, `passages[]` (only when a query is given) |
| `memory` | `insights[]` (`type`, `insight`, `confidence`, `sampleSize`, `editedByUser`) |
| `meta` | `generatedAt`, `revision` (last stored change; used for optimistic concurrency), `sections`, `provenance` (per field: sources used, winner first, and `inferred`), `issues[]`, `completeness` |

---

## 4. Required, recommended and optional

- **Required**: onboarding will not complete without these (the rules are
  enforced by `companyStep1Schema` and `companyAudienceSchema`). Workflows still
  run for older workspaces that lack them, but `completeness.complete` is false.
- **Recommended**: noticeably better output. Surfaced in the setup checklist.
- **Optional**: used when present, never asked for.

| Field | Requirement | Sources, in precedence order | Resolution | Consumers |
| --- | --- | --- | --- | --- |
| `identity.name` | **required** | workspace profile | precedence | all |
| `identity.description` | **required** | workspace profile | precedence | content, media, planner, campaigns, advisor, outreach, engagement, lead discovery |
| `audience.marketMode` | **required** | workspace profile | precedence | content, media, planner, campaigns, advisor |
| `audience.stated` | **required** | workspace profile → latest plan | precedence | content, media, planner, campaigns, advisor |
| `identity.offerings` | recommended | workspace profile | precedence | all writers |
| `identity.industry` | recommended | workspace profile | precedence | all writers, trends |
| `identity.website` | recommended | workspace profile → knowledge base (single synced site) | precedence | content, competitors, onboarding |
| `objectives.goals` | recommended | workspace profile → latest plan | precedence | content, planner, campaigns, advisor, briefing |
| `channels.preferred` | recommended | workspace profile → latest plan | precedence | planner, campaigns, advisor |
| `voice.summary` | recommended | voice profile → onboarding notes → plan guidelines | layered | all writers, trends |
| `knowledge.coverage` | recommended | knowledge base | union | all writers |
| `identity.visual` | optional | workspace profile | precedence | media |
| `audience.roleTitles` | optional | outreach targeting ∪ discovery profiles | union | content, outreach, lead discovery, advisor |
| `audience.industries` | optional | outreach targeting ∪ discovery profiles | union | content, outreach, lead discovery, advisor |
| `audience.companyStages` | optional | outreach targeting | union | content, outreach, lead discovery |
| `objectives.contentFormats` | optional | workspace profile | precedence | content, planner, campaigns |
| `channels.connected` | optional | connections | union | content, intelligence, briefing |
| `market.competitors` | optional | competitor profiles ∪ trend watch list | union | advisor, competitors, trends, planner |
| `market.keywords` | optional | trend config | precedence | trends, advisor |
| `market.geo` | optional | trend config | precedence | trends |
| `memory.insights` | optional | marketing memory | union | content, outreach, campaigns, planner, advisor |

"Workspace profile" means the onboarding wizard and the Settings pages. Both
write to the same storage, so the most recent edit is already the stored value.

`completeness.score` runs from 0 to 100, with required fields weighted ×2 and
recommended ×1. A field in a section that was not loaded counts as unknown, not
as missing.

---

## 5. Source mapping

### Onboarding → context

| Wizard field | Storage | Context field |
| --- | --- | --- |
| Company name | `Company.name` | `identity.name` |
| Website | `Company.website` | `identity.website` |
| Industry | `Company.industry` | `identity.industry` |
| What do you do? | `preferences.business.description` | `identity.description` |
| What you sell | `preferences.business.offerings` | `identity.offerings` |
| B2B / B2C | `preferences.marketingProfile.marketMode` | `audience.marketMode` |
| Typical customer | `preferences.marketingProfile.audience` | `audience.stated` |
| Goals | `preferences.marketingProfile.goals` | `objectives.goals` |
| Tone / brand voice notes | `Company.brandVoiceNotes` | `voice.notes` (and `voice.summary` fallback) |
| *(settings)* Channels | `preferences.marketingProfile.channels` | `channels.preferred` |
| *(settings)* Logo, colours | `preferences.brand` | `identity.visual` |
| *(settings)* Formats | `preferences.contentFormats.enabled` | `objectives.contentFormats` |

### Knowledge base → context

| Source | Context field |
| --- | --- |
| `KnowledgeChunk` counts by `category` | `knowledge.covered`, `knowledge.missing` (every category except OTHER), `knowledge.totalChunks`, `knowledge.uncategorisedChunks` |
| `KnowledgeSource` with type WEBSITE | `knowledge.websiteUrls`; fallback for `identity.website` when exactly one exists |
| `retrieve(query)` | `knowledge.passages`, labelled by category when rendered |

Documents are **evidence**, not settings. A pitch deck never overrides the
stated description; it grounds what may be claimed.

### Brand voice → context

| Source | Context field |
| --- | --- |
| `Company.brandVoiceProfile` (validated by `brandVoiceProfileSchema`, and dropped if invalid) | `voice.profile`; its `summary` becomes `voice.summary` |
| `Company.brandVoiceNotes` | `voice.notes`; becomes `voice.summary` when no profile exists |
| Latest `MarketingPlan.inputs.brandGuidelines` | `voice.planGuidelines`; last-resort `voice.summary` |

### Marketing memory → context

| Source | Rule |
| --- | --- |
| `MarketingMemory` where `isActive` | mapped to `memory.insights` |
| `supportingDataSummary.status = 'insufficient'` | dropped. It is a dashboard message, not a pattern. |
| `supportingDataSummary.editedByUser` | carried through, and ranked first |
| Ordering | user-edited, then confidence, then sample size |
| Near-duplicates of the same type | collapsed to one (compared ignoring case and punctuation) |

---

## 6. Duplicates and conflict resolution

### General rules

1. **What the user stated beats everything derived.** Settings and onboarding
   beat plans, AI-seeded config, documents and learned patterns.
2. **Workspace settings beat a single plan.** A plan is a one-month brief, and
   settings are used everywhere else. The plan only fills a gap, and the value
   is marked `inferred: true`.
3. **A system of record beats a lightweight list** (`CompetitorProfile` over
   the trend watch list).
4. **A derived-and-editable artefact beats its raw input** when it was generated
   from that input (the voice profile over the notes). This is the `layered`
   strategy, and a difference between the two is expected, so it is not reported.
5. **Lists merge; they do not compete.** Tag lists are unioned and de-duplicated
   case-insensitively, and the higher-precedence source's spelling is kept.
6. **Learned memory is advisory.** It never overrides the brand voice, the
   stated audience or topics to avoid. The rendered prompt says so explicitly.
7. **Documents ground claims; they do not set fields.**
8. **Nothing is silently dropped.** Every overridden value is kept in
   `meta.issues` with its source so the user can fix whichever one is wrong.

"Different" means different after normalising case, whitespace and trailing
punctuation. Websites compare by host, ignoring `www.`.

### Known duplicates

| Fact | Where it is duplicated | Winner | Reported as |
| --- | --- | --- | --- |
| Audience description | Settings ↔ plan `audience` | Settings | `value_conflict` |
| Business goals | Settings ↔ plan `businessGoals` | Settings | `value_conflict` |
| Channels | Settings ↔ plan `channels` | Settings | `value_conflict` |
| Website | `Company.website` ↔ synced WEBSITE source | Settings | `value_conflict` (different domain only) |
| Brand voice | profile ↔ notes ↔ plan guidelines | Profile | not reported (layered); a `consistency` note appears when notes exist but no profile has been generated |
| Competitors | `CompetitorProfile` ↔ `trendConfig.competitorNames` | Merged; profile metadata wins | `consistency` for names only on the watch list (often AI-seeded guesses) |
| Buyer roles / industries | `OutreachConfig` ↔ `DiscoveryProfile.criteria` | Merged | none |
| Market mode vs targeting | B2C mode ↔ outreach business roles | Both kept | `consistency` (legitimate for distributor or venue outreach) |
| Preferred vs connected channels | settings ↔ connections | Both kept | `consistency` (Aura can plan for the channel but cannot publish there) |

Not duplicates, despite the names: `Company.industry` is the company's own
industry, while `OutreachConfig.industries` lists the industries it sells
into. They map to `identity.industry` and `audience.industries` respectively.

---

## 7. Migration status

| Workflow | Status |
| --- | --- |
| Campaign planner (`server/campaigns/planner.ts`) | Via `getBrandContext` → Business Context |
| Monthly planner (`server/planner/plan.service.ts`) | Via `getBrandContext` → Business Context |
| Lead qualification (`server/leads/discovery/scoring.ts`) | `businessContextToPrompt(…, 'qualification')`, loaded once per discovery run. Replaces tone notes used as the company description. |
| Content generator | To migrate → `content` preset |
| Outreach drafting | To migrate → `outreach` preset |
| Engagement comments | To migrate → `engagement` preset |
| Image prompts | To migrate → `image` preset |
| Advisor | To migrate → `advisor` preset (currently reads raw `brandVoiceNotes` as fallback) |
| Trend digest and trend seeding | To migrate → `voice.summary` in place of raw `brandVoiceNotes` |

Each remaining migration is a mechanical swap of that workflow's hand-assembled
blocks for one preset call. Do them one PR at a time, so any change in prompt
output can be reviewed per workflow.

---

## 8. Updating the context

Every write to business information goes through `updateBusinessContext`:
onboarding, all the settings screens, logo upload, AI voice generation, and
`PATCH /api/business-context`. A value can only enter the trusted context by
passing the same checks, wherever it was typed.

```ts
await updateBusinessContext({
  companyId,
  userId,
  origin: 'settings', // 'onboarding' | 'settings' | 'api' | 'ai'
  patch: { audience: { stated: 'Ops leads at logistics firms' } },
  expectedRevision, // optional: ctx.meta.revision from the last read
});
// -> { changed: ['audience.stated'], revision }
```

**Patch semantics:** an omitted key is unchanged, and `null` or `''` clears the
field.

### Writable fields

| Section | Fields |
| --- | --- |
| `identity` | `name`, `website`, `industry`, `description`, `offerings`, `visual.{logoAssetId, primaryColor, secondaryColor, accentColor}` |
| `audience` | `marketMode`, `stated` |
| `objectives` | `goals`, `contentFormats` |
| `channels` | `preferred` |
| `voice` | `notes`, `profile` |

Everything else in the context is read-only here, because another module owns
it. Sending it is rejected with a message that says where to edit it instead:

| Read-only field | Owned by |
| --- | --- |
| buyer role titles, industries, stages | Outreach targeting, Lead discovery |
| connected channels | Settings → Connections |
| competitors, keywords, geo | Competitors, Settings → Trends |
| knowledge coverage | Knowledge base |
| memory insights | Marketing Memory (it has its own edit and dismiss operations) |

### Update rules

| # | Rule | Enforced in |
| --- | --- | --- |
| R1 | Only writable fields. Unknown or module-owned fields are rejected. | patch schema (`.strict()`) |
| R2 | Shape: enums (market mode, channels, formats), length caps, website URL, hex colours, asset id format. Control characters are stripped, spaces collapsed, lists de-duplicated. | patch schema |
| R3 | Quality, applied to **changed** values only: name ≥ 2 characters, description ≥ 20, audience ≥ 10. Placeholder answers (`n/a`, `tbd`, `test`, `asdf` and similar) are refused in prose fields. | `update.ts` |
| R4 | Required fields cannot be cleared, and onboarding must supply all of them. | `update.ts` |
| R5 | References must belong to the workspace. A logo asset id must be one of its own assets. | write service |
| R6 | AI-originated writes may only set `voice.profile`. A model can never rewrite what the business stated. | `update.ts` |
| R7 | A write that changes nothing is not stored and not audited. | `update.ts` |
| R8 | Merge, never replace. Other `preferences` sections (such as autopilot) survive every write. | `update.ts` |
| R9 | Optimistic concurrency: a stale `expectedRevision` is refused with 409. | write service |

R3 applies only to changed values because the settings form re-sends every
field. Without that, a workspace with an older, shorter description could not
save an unrelated edit.

**Errors.**
- **422:** a shape failure (ZodError) or a rule refusal (`BusinessContextUpdateError`). The response carries per-field `details`, and every refused field is reported at once.
- **409:** the stored context changed since `expectedRevision`.
- **403:** the caller lacks `company:update`.

Rule refusals are keyed by each screen's own field names (for example,
`audience.stated` → `audience`), so existing forms show them next to the right
input.

**Audit.** Each real change writes one audit entry with `via: 'business-context'`,
the `origin`, and the exact `changedFields`. Brand voice edits keep their
`BRAND_VOICE_UPDATED` / `BRAND_VOICE_GENERATED` actions.

### Connected screens

| Screen / writer | Route or service | Adapter |
| --- | --- | --- |
| Onboarding wizard | `POST /api/companies` → `createCompanyForUser` (rules planned against an empty workspace, written in the create transaction) | `onboardingPatch` |
| Company profile | `PATCH /api/companies/:id` → `updateCompany` | `companyProfilePatch` |
| Audience & goals | `PATCH /api/company/audience` | `audiencePatch` |
| Brand colours | `PATCH /api/company/brand` | `brandPatch` |
| Logo upload | `POST /api/company/logo` → `storeCompanyLogo` | direct patch |
| Content formats | `PATCH /api/company/formats` | `formatsPatch` |
| Brand voice edit | `PUT /api/brand-voice` → `updateBrandVoiceProfile` | direct patch |
| Brand voice generation | `generateBrandVoiceProfile` (origin `ai`) | direct patch |

Each screen keeps its own request schema, so its existing validation messages
are unchanged. The adapter translates the parsed input into a context patch.

The old direct writers (`saveBrandAssets`, `saveMarketingProfile`,
`saveContentFormats`) are deprecated. The only remaining caller is
`scripts/verify-onboarding.ts`.
