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
| Source, confidence, freshness | [`server/business-context/facts.ts`](../server/business-context/facts.ts) (pure) |
| Snapshot: structure, views, TTL | [`lib/business-context-snapshot.ts`](../lib/business-context-snapshot.ts) (pure, client-safe) |
| Snapshot: build, views, prompt | [`server/business-context/snapshot.ts`](../server/business-context/snapshot.ts) (pure) |
| Snapshot: storage + refresh | [`server/business-context/snapshot.service.ts`](../server/business-context/snapshot.service.ts), table `BusinessContextSnapshot` |
| Snapshot HTTP | `GET` and `POST /api/business-context/snapshot` |
| Tests | [`tests/business-context.test.ts`](../tests/business-context.test.ts), [`tests/business-context-service.test.ts`](../tests/business-context-service.test.ts), [`tests/business-facts.test.ts`](../tests/business-facts.test.ts), [`tests/context-snapshot.test.ts`](../tests/context-snapshot.test.ts) |

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
| `objectives` | `goals`, `contentFormats[]` (empty = all formats), `campaigns[]` (running and paused: name, goal, audience, themes, end date) |
| `channels` | `preferred[]` (where it publishes; drives planning), `connected[]` (where Aura can act; drives execution) |
| `voice` | `profile` (structured brand voice), `notes` (raw onboarding notes), `planGuidelines`, `summary` (resolved one-liner) |
| `market` | `competitors[]` (`name`, `url`, `tracked`, `source`), `keywords[]`, `geo` (country, region, city, language) |
| `knowledge` | `totalChunks`, `covered[]`, `missing[]`, `uncategorisedChunks`, `websiteUrls[]`, `passages[]` (only when a query is given) |
| `memory` | `insights[]` (`type`, `insight`, `confidence`, `sampleSize`, `editedByUser`) |
| `history` | `recentContent[]` (published or approved in the last 90 days), `performance` (latest analytics period's metrics) |
| `meta` | `generatedAt`, `revision` (last stored change; used for optimistic concurrency), `facts` (source, confidence and freshness per field; see §9), `sections`, `provenance` (per field: sources used, winner first, and `inferred`), `issues[]`, `completeness` |

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
| `objectives.campaigns` | optional | campaigns | union | planner, campaigns, advisor, content |
| `history.recentContent` | optional | content history | union | planner, advisor, content, briefing |
| `history.performance` | optional | analytics | precedence | advisor, planner, intelligence, briefing |

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

Every AI workflow now reads the business through this layer. See
[BUSINESS-CONTEXT-SOURCES-AUDIT.md](BUSINESS-CONTEXT-SOURCES-AUDIT.md) §5 for
the before-and-after of each module, and §1 of that document for the full
field-by-field audit of Aura's existing sources.

| Workflow | Reads the context via |
| --- | --- |
| Content generator, draft refine | `content` preset |
| Outreach drafting | `outreach` preset |
| Engagement comments | `engagement` preset |
| Image prompts | context data, visual rendering |
| Advisor | identity, audience and channels block, plus `voice.summary` and `objectives.goals` |
| Trend digest, trend seeding | identity block and `voice.summary`; identity and buyer facts for seeding |
| Campaign planner, monthly planner | `getBrandContext` (a projection of the context) |
| Lead qualification | `qualification` preset |

`pnpm verify:context-sources` proves against a real database that every stored
business value is reachable, superseded with a recorded conflict, or
intentionally unmapped with a reason.

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

---

## 9. Source, confidence and freshness

Every business fact in the context carries a record in `meta.facts[fieldPath]`:

| Property | Meaning |
| --- | --- |
| `source` | The table the winning value was read from (`workspace_profile`, `trend_config`, …). |
| `sourceType` | What kind of origin it has (see below). |
| `confidence` | `confirmed` · `high` · `medium` · `low` · `unverified` |
| `trusted` | Whether Aura may state it as a fact about the business: a trusted source type, not a fallback, and not unverified. |
| `inferred` | Taken from a fallback source because the primary one was empty. |
| `capturedAt`, `ageDays` | When the value was captured. Null for values saved before capture dates were recorded. |
| `freshness` | `fresh` · `aging` (past 75% of its maximum age) · `stale` · `unknown` |
| `conflicted` | Another source holds a different value (details in `meta.issues`). |
| `note` | Why, when it isn't obvious (for example, "Taken from this month's plan because settings are empty"). |

Competitors carry `sourceType`, `confidence` and `capturedAt` individually, and
memory insights carry `capturedAt` and `freshness`, because a single list can
mix a tracked competitor with an AI guess.

### Source types

| Source type | Trusted | Default confidence | Where it comes from |
| --- | :-: | --- | --- |
| `user_provided` | ✓ | confirmed | Typed or confirmed in Settings or through the API |
| `onboarding` | ✓ | confirmed | The onboarding wizard |
| `connected_platform` | ✓ | high | Connected accounts (`Connection`, `LinkedInConnection`) |
| `uploaded_document` | ✓ | high | The business's own uploads in the knowledge base |
| `system_generated` | ✓ | high | Computed by Aura |
| `knowledge_base` | | medium | Crawled website or blog content |
| `marketing_memory` | | from the insights (high/medium/low; user-edited = confirmed) | Learned from real performance |
| `ai_derived` | | unverified | Suggested by a model and never confirmed by a person |

How each source type is determined:
- **Workspace fields.** Every write through `updateBusinessContext` stamps
  `preferences.factMeta[path] = { sourceType, capturedAt }`. Onboarding writes
  get `onboarding`, Settings and API writes get `user_provided`, and AI writes
  get `ai_derived`. Clearing a field removes its entry.
- **Voice profile.** A profile with no record of human review is treated as an
  AI draft, because every profile starts as one.
- **Trend keywords and watch-list competitors.** These are `ai_derived` when the
  settings were AI-seeded and no person has saved them since (no
  `TREND_CONFIG_UPDATED` audit entry). Otherwise they are `user_provided`.
- **Other tables.** Each fact takes its date from that table's own timestamp.

A value borrowed from a fallback source (last month's plan, the synced
website) is capped at `medium` and is never `trusted`.

### Freshness rules

| Field | Max age | Why |
| --- | --- | --- |
| `objectives.goals` | 90 days | Goals are set per quarter |
| `memory.insights` (and each insight) | 60 days | Performance patterns decay |
| `channels.connected` | 30 days since last sync | A connection that hasn't synced may be broken |
| `identity.offerings`, `audience.*` targeting and stated audience, `market.competitors`, `market.keywords` | 180 days | These drift within a year |
| `identity.description`, `identity.website`, `channels.preferred`, `voice.summary`, `knowledge.coverage` | 365 days | Review yearly |
| `identity.visual` | 730 days | Changes with a rebrand |
| name, industry, market mode, content formats, geo | none | Standing facts |

A value taken from a marketing plan whose month has ended is stale
immediately, whatever its age.

### Identifying stale, unverified and conflicting facts

The builder adds these to `meta.issues`:
- **`stale`** for important fields (required or recommended) and for any
  AI-derived fact past its maximum age. It is a warning for required fields.
  When the stale value also won a conflict, the message says another source has
  a different value.
- **`unverified`** for important fields that aren't trusted, and for every
  AI-derived fact. The message says it is an assumption until someone reviews it.
- **`value_conflict`** and **`consistency`**, as before (§6). A conflicted fact
  has `conflicted: true`.

Conflict resolution itself is unchanged (§6): the registered precedence decides
the winner. The fact record then shows how much that winner can be trusted and
how current it is. A trusted value is never replaced automatically by a newer
untrusted one; the conflict is reported for a person to settle.

### Confirming a fact

`updateBusinessContext({ …, confirm: ['voice.profile'] })` records that a
person reviewed a value without changing it. The fact becomes trusted, and its
freshness restarts from the confirmation date. Rules:
- **AI writes cannot confirm.**
- **Only a value that exists can be confirmed.**
- **Only the stored writable fields can be confirmed.**
- **The original source type is kept.** A re-confirmed onboarding answer stays
  `onboarding`; only an untrusted value becomes `user_provided`.

Saving the brand voice card confirms the profile, so a reviewed AI draft becomes
the business's own voice. `PATCH /api/business-context` accepts `confirm`.

### What AI workflows receive

`businessContextToPrompt` never presents an assumption as a verified fact:
- **Unreviewed AI voice profile.** Headed "drafted by AI … not yet reviewed",
  with the company's own notes alongside.
- **AI-suggested competitors.** Listed separately as "Possibly competitors
  (suggested by AI, never confirmed)", and the model is told never to name them
  as competitors.
- **AI-suggested keywords.** Labelled unconfirmed.
- **Memory.** Stale patterns are left out. Low-confidence ones are marked
  "tentative — small sample", and user-edited ones "confirmed by the company".
- **Any other rendered fact that is untrusted or stale.** Listed under
  `RELIABILITY NOTES` with the reason, and the model is told to treat these as
  working assumptions and never state them as verified facts. When everything is
  confirmed and current, the block is omitted.

`getWorkflowContext` returns the same list as `caveats: [{ field, label, reason }]`,
so an Opportunity or Recommendation screen can show the user exactly what its
output rests on.

---

## 10. Business Context Snapshot

The full context (§3) is built for resolution and audit. An AI workflow needs
something smaller: a current statement of what is **true** about the business,
kept apart from what is only assumed. The snapshot is that statement, and it is
the recommended way for AI workflows, including the upcoming Recommendation
and Content workflows, to receive business context.

```ts
import { getContextSnapshot } from '@/server/business-context/snapshot.service';

const { snapshot, prompt, status } = await getContextSnapshot(companyId, {
  view: 'recommendation', // or 'content', 'opportunity', 'planning', 'outreach', 'engagement', 'full'
  strict: false,          // true = leave assumptions out entirely
});
// prompt: compact fact sheet to put in the model's context
// snapshot.fingerprint: record it with the AI output, so the output can be
// traced to the exact business context it was produced from
```

### Structure

| Section | Contents | Built from |
| --- | --- | --- |
| `business` | name, description, industry, website | identity |
| `products` | offerings; up to 3 highlights quoted from the business's own uploaded differentiators, product docs, company info or pitch deck | identity.offerings + knowledge base |
| `audience` | market mode, buyer description, roles, industries, company stages | audience |
| `goals` | current goal | objectives.goals |
| `voice` | summary, tone, topics to avoid, vocabulary, emoji, hashtags, the business's own notes | voice |
| `channels` | where it publishes; which channels are connected | channels |
| `learning` | up to 8 learned performance patterns, with confidence and sample size | marketing memory |
| `market` | confirmed competitors, market topics | market |
| `trust` | source type, confidence, capture date and freshness for every included fact | `meta.facts` (§9) |
| `assumptions` | present but untrusted or stale, each with its reason | `meta.facts` (§9) |
| `omitted` | left out, and why | |
| `gaps` | required information the business hasn't supplied | completeness |
| `fingerprint`, `revision`, `generatedAt` | which business state it describes | |

### What goes in

| Fact | Where it goes |
| --- | --- |
| Trusted and not stale | Main section, with its `trust` entry |
| Untrusted (AI-derived, fallback, crawled) or stale | `assumptions`, with the reason; `omitted` in strict mode |
| Learned pattern: stale | `omitted` |
| Learned pattern: low confidence and not confirmed by the user | `assumptions` ("small sample") |
| AI-suggested competitor | `assumptions` ("Possible competitors"), never in `market.competitors` |
| Unreviewed AI voice profile | `assumptions`; the business's own notes stay in `voice.notes` |
| Product evidence | Only from uploaded material in product-related categories; crawled pages are never quoted |

Learning is included as evidence, labelled with its strength, and never
presented as a business fact.

### Views

| View | Sections |
| --- | --- |
| `full`, `recommendation`, `planning` | all |
| `content` | business, products, audience, goals, voice, channels, learning (no market) |
| `opportunity` | all except voice |
| `outreach` | business, products, voice, learning (no audience persona) |
| `engagement` | business, voice |

A view also filters `trust`, `assumptions`, `omitted` and `gaps` to its own
sections. All views of the same state share the full snapshot's `fingerprint`.

### Optimised for AI consumption

- **Bounded size.** Lists are capped (6 roles or industries, 8 insights, 8
  competitors, 10 keywords, 3 product highlights of at most 280 characters), so
  the size is predictable. `meta.estimatedTokens` reports it.
- **Facts, not instructions.** `prompt` is a compact fact sheet headed "confirmed,
  current facts", followed by an `ASSUMPTIONS` block ("never state them as
  facts") and a `NOT PROVIDED` line ("do not invent these"). Each workflow adds
  its own task and writing rules.
- **Stable fingerprint.** The fingerprint hashes the content, not the build
  time: an unchanged business keeps the same fingerprint across rebuilds.

### Refresh and update behaviour

One full snapshot is stored per workspace in `BusinessContextSnapshot`, and
views are cut from it on read. A read rebuilds it first when:

| Reason | When |
| --- | --- |
| `missing` | Never built |
| `version` | The snapshot format changed in a deploy, or the stored payload no longer parses |
| `invalidated` | A writer the source stamp cannot see asked for a rebuild |
| `sources_changed` | The source stamp no longer matches |
| `expired` | Older than 6 hours, because freshness depends on today's date |
| `forced` | `POST /api/business-context/snapshot`, or `force: true` |

**Source stamp.** The stamp is a hash of the latest change time and row count
of every source table: Company, OutreachConfig, active DiscoveryProfiles,
CompetitorProfiles, CompanyTrendConfig, MarketingPlans, connected Connections,
active LinkedInConnection, KnowledgeChunks and active MarketingMemory.
- **Coverage.** It catches edits, additions and deletions in every module with
  no hooks there. Every write through the Business Context service bumps
  `Company.updatedAt`, so all context updates refresh the snapshot.
- **The exception.** Editing a memory insight's text in place has no timestamp,
  so `updateMemoryInsight` calls `invalidateContextSnapshot`. Invalidation is
  best-effort; the TTL bounds how long a missed one can last.
- **Timing.** The stamp is taken before building. A change made during a build
  leaves the stored stamp behind, so the next read rebuilds.

**HTTP.**
- `GET /api/business-context/snapshot?view=content&strict=1` returns
  `{ snapshot, prompt, status: 'current' | 'rebuilt', reason? }`.
- `POST` rebuilds immediately (owners and admins only).

