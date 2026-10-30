# Content Studio (Generation, Brief, Formats, Quality)

> Content Studio is where Aura writes marketing copy for the business. Someone picks a format (9 of them, from a LinkedIn post to promotional copy), a network and a source: a brief, a trend or a campaign, usually reached from an accepted Aura recommendation. Aura assembles a context package (the current Business Context Snapshot, the Content Brief, matching knowledge, brand voice, earlier posts) with sensitive data redacted, and writes against the format's schema. It then runs the result through deterministic rules (length, CTA, alcohol code, unsupported claims, brand safety), a fact check, the workspace's compliance policy and an independent AI Reviewer, before a person can submit or approve it. It exists so drafts are grounded in what is true about this business for this piece. It also keeps any draft that breaks a rule, invents a fact or sells off a tragedy from reaching approval.

## 1. Overview

Content Studio is the "Content Brief -> Generation + checks" stage of the Aura pipeline (Business Context -> Signals -> Opportunities -> Recommendations -> **Content Brief -> Generation + checks** -> Review/Approval -> Execution).

Its main capabilities:

| Capability | What it does | Core module |
| --- | --- | --- |
| Content Brief | 16-field, versioned (`CONTENT_BRIEF_VERSION = 1`) brief built from an accepted recommendation; validated before generation | `lib/content-brief.ts`, `server/content/content-brief.service.ts` |
| Generation context | Per-draft package of 14 sections under a 3,200-token budget, with relevance filtering, redaction and a trace | `lib/generation-context.ts`, `server/content/generation-context.service.ts` |
| Formats | 9 formats defined once (template, required fields, channel, length, CTA mode, voice, output schema) | `lib/content-formats.ts`, `lib/validations/content.ts`, `lib/content-playbook.ts` |
| Generation | Writes 1 to 3 versions, checks each, repairs blocking issues once, stores the draft with its full provenance | `server/content/generator.ts` |
| Rewrites | One-click regenerate / shorten / expand / tone / improve / custom / fix_review, with undo | `generator.ts` (`refineDraft`, `undoDraft`, `switchVariation`) |
| Variations and versions | Shorter, longer, tone, CTA, headline, channel and image variations, up to 8 versions per draft, a facts guardrail and a topic-drift guard; per-version edit, rewrite, revert and CTA suggestions | `lib/content-variations.ts`, `server/content/variations.service.ts`, `server/content/version-workspace.service.ts` |
| Quality rules | Deterministic checks (`checkQuality`): length, hashtags, CTA, alcohol code, never-mention topics, unsupported claims, robotic phrasing, brand-safety tone, unconfirmed post details | `lib/content-quality.ts`, `server/content/quality.service.ts` |
| Fact check | Extracts claims and checks them against trusted sources; contradicted or unsupported figures block approval | `lib/fact-check.ts`, `server/content/fact-check.service.ts` |
| Compliance policy | Rule packs, workspace rules, channel rules and required disclaimers. The policy is stored as data and fed to both the writer and the reviewer | `lib/compliance-policy.ts`, `server/content/compliance.service.ts` |
| Brand safety | Deterministic source classification (`clear` / `caution` / `unsuitable`). It refuses promotional formats on grave sources and blocks promotional tone | `lib/brand-safety.ts` |
| AI Reviewer | Independent model review on 11 weighted dimensions, combined with the rules, the fact check and the policy into `pass` / `review_required` / `fail` | `lib/content-review.ts`, `server/content/review.service.ts` |
| Post details | Website, address, phone and email stored in `body.details`. The AI never writes them, and typed values must be confirmed | `lib/post-details.ts` |
| Platforms | Destination registry (LinkedIn, Instagram, X, Facebook): ratios, file limits, art direction, which formats run where | `lib/platforms.ts` |

Closely related functionality is documented in sibling features. Images and creatives are in [12](../12-media-graphics-and-creatives/). The unified review screen, approval record, versions and trace are in [13](../13-review-approval-versions-and-trace/). Publishing and scheduling are in [20](../20-publishing-execution-and-scheduling/), the brand voice profile is in [04](../04-knowledge-base-and-brand-voice/), and the model client is in [23](../23-ai-layer/).

## 2. User-facing behaviour

### Screens

| Route | File | What the user sees and can do |
| --- | --- | --- |
| `/dashboard/content` | `app/dashboard/content/page.tsx` | The "Content Studio" board (`QueueBoard`) with columns per `ContentStatus` (Draft, Pending approval, Approved, Rejected, Published). It shows the latest 200 drafts (`DRAFT_BOARD_LIMIT`), and the **Create** dialog (`CreateContentDialog`) writes from a brief or a campaign. When there are no drafts, an empty state explains that nothing publishes until someone approves it. |
| `/dashboard/content/new` | `app/dashboard/content/new/page.tsx` -> `NewContentForm` | The single hand-off point into Content Studio, from Opportunities, Aura Suggests, Trends and the Content plan. `?rec=<id>` loads the recommendation's creation plan (`getCreation`) and Content Brief input (`getBriefInput`). The form shows the brief (`ContentBriefPanel`), rebuilt as the format or network changes; the generation options (`GenerationOptions`: network, 1 to 3 versions, tone); and either a `CreationNotice` when the suggestion has nothing to write or a "suggestion unavailable" message. Only the workspace's enabled formats are offered. |
| `/dashboard/content/[id]` | `app/dashboard/content/[id]/page.tsx` | The draft page. It shows the preview (`DraftPreview`, per format) and the versions side by side (`VersionWorkspace`). It has the writing assistant (`ContentAssistantPanel`: rewrites, variations, versions list) and `CreatedFromSuggestion` (which suggestion, why, evidence). The **Review** panel (`ReviewPanel`) shows the AI Reviewer's result and offers "Regenerate with review feedback"; the **Fact check** panel (`FactCheckPanel`) lists each claim with its status. It also shows the visual brief, the graphic and creative studios, the post composer, multi-publish, execution readiness and status actions (`DraftActions`). |
| `/dashboard/content/calendar` | `app/dashboard/content/calendar/page.tsx` | The "Content calendar": drafts, scheduled and published content by date. `?month=YYYY-MM` selects the month. |
| `/dashboard/settings/compliance` | `app/dashboard/settings/compliance/page.tsx` (form in `components/dashboard/settings/compliance-form.tsx`) | Settings -> Compliance has six sections: rule packs, words and claims never used, required disclaimers, always send to a person, CTAs and links, and **Try the rules**. Members see it read-only, and **Reset to defaults** restores the starting policy. |
| `/dashboard/settings/formats` | `app/dashboard/settings/formats/page.tsx` | Settings -> Content formats: which of the 9 formats the workspace uses (enforced by `getEnabledContentTypes` in the generate route). |

### Roles (from `lib/rbac.ts`)

| Action | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- |
| View board, drafts, review, fact check | yes | yes | yes | yes |
| Generate, edit, refine, make variations, run review, undo, submit for approval, queue (`content:create`) | yes | yes | yes | no |
| Approve / reject, single or bulk (`content:approve`) | yes | yes | no | no |
| Publish, schedule an approved draft, retry publications (`content:publish`) | yes | yes | no | no |
| Change the compliance policy or reset it (`company:update`) | yes | yes | no | no |
| Try copy against the rules (`POST /api/company/compliance`, action `test`) | yes | yes | yes | yes |

## 3. How it works

### 3.1 Entry and the Content Brief

1. A recommendation is accepted (feature 09). The page calls `POST /api/recommendations/:id/creation` first when the plan says `acceptsOnCreate`, because no draft is written for a suggestion nobody agreed to.
2. `getContentBrief(companyId, recommendationId, { type, platform })` in `server/content/content-brief.service.ts` loads the Context Handoff, the opportunity and the enabled formats, and calls `buildContentBrief()` in `lib/content-brief.ts`. The service is workspace-scoped, so another workspace's recommendation returns null.
3. The brief has 16 fields (`BRIEF_FIELDS`): `recommendation`, `opportunity`, `businessContext`, `marketingGoal`, `targetAudience`, `channel`, `recommendedAction`, `keyMessage`, `reason`, `evidence`, `expectedOutcome`, `cta`, `brandVoice`, `relevantMemory`, `contentType` and `assetRequirements`. Each field is `required`, `recommended` or `optional` (`BRIEF_FIELD_POLICY`, which also gives the fix link). Values that can come from more than one place carry a `source`: `recommendation`, `opportunity`, `business_profile`, `campaign`, `brand_voice`, `marketing_memory`, `content_playbook`, `person` or `platform`.
4. `readiness` is one of the following:
   - `ready`
   - `ready_with_gaps`: recommended fields are missing, and they are listed in `missing` with a fix link.
   - `blocked`, with `blockedBy`
5. A format's `requiredFields` upgrade brief fields to required:
   - Email: the CTA destination
   - Ad: the audience and the CTA destination
   - Campaign copy: the goal and the audience
   - Promo: the CTA destination
6. `briefText()` prefills the editable brief, capped at `BRIEF_TEXT_LIMIT = 2000` characters. `briefPrompt()` holds the writer to the brief, and `briefToContentRequest()` maps it to the generate request.

### 3.2 `POST /api/content/generate` (route checks, in order)

1. `requireActiveCompany()` runs, then `can(role, 'content:create')`. Without the permission the route returns **403**.
2. The body is parsed with `generateContentSchema`, which has these fields:
   - `type` (one of 9)
   - `source`: `{ kind: TREND|BRIEF|CAMPAIGN, ref?, brief? <= 2000 }`
   - `campaignId?`
   - `platform?`
   - `variations`: 1 to 3, default 1
   - `tone?`: professional, friendly, playful, bold, warm or concise
   - `recommendationId?` (up to 64 characters)
   - `idempotencyKey?` (8 to 64 characters)
3. **Idempotency.** An existing draft by this user with the same `aiMetadata.idempotencyKey` is returned with `reused: true` (200). The forms generate one key per open form.
4. **Enabled formats.** A format turned off for the workspace returns **400**, pointing to Settings -> Content formats.
5. **The recommendation.** A recommendation that is missing or belongs to another workspace returns **409** with a fix link to `/dashboard/suggestions`. The route also returns **409** when the plan has `!canCreate` or still needs acceptance (`acceptsOnCreate`).
6. **The brief.** It is rebuilt for exactly the chosen `type` and `platform` and passed through `validateContentBrief()` (schema, required fields, not blocked, format/network consistency). Failure returns **409** with `errors` and the first required fix.
7. `generateDraft()` runs (`maxDuration = 60`). After it, `recordCreation()` adds the draft to the suggestion's history. A failure there is logged, but the draft is kept.
8. When no AI provider is configured (`ClaudeNotConfiguredError`), the route returns **503**: "Add GEMINI_API_KEY (or ANTHROPIC_API_KEY)".

### 3.3 `generateDraft()` (server/content/generator.ts)

1. **Platform check.** A platform outside `platformsForType(type)` returns **422**. The formats run on these networks:

   | Format | Networks |
   | --- | --- |
   | `LINKEDIN_POST` | LinkedIn, Facebook |
   | `IMAGE_POST` | all 4 |
   | `CAROUSEL` | LinkedIn, Instagram, Facebook |
   | `TWEET_THREAD` | X |
   | `BLOG` | LinkedIn (shapes the image only) |
   | `AD` | all 4 |
   | `EMAIL`, `CAMPAIGN_COPY`, `PROMO` | none |

2. **Resolve the brief** (`resolveBrief`): BRIEF uses the person's text, CAMPAIGN uses the campaign, and TREND looks the item up in a recent digest.
3. **Reference pages** (`fetchReferenceContext`). Up to **2** URLs found in the brief, the source brief or the company website are fetched live with `politeFetchHtml`. Each is reduced to text and capped at **4,000** characters. Fetching is best-effort.
4. **Brand safety, before anything is written.** `classifySource(sourceMaterial)` returns `clear`, `caution` or `unsuitable` from deterministic patterns over 11 topics (`SENSITIVE_TOPICS`):
   - `unsuitable`: death, violence, conflict, self_harm and missing
   - `caution`: disaster, injury, illness, hardship, legal and discrimination

   When `refusalFor()` returns a message, generation is refused with **422** `source_not_marketable` and an audit entry with `refused: true`. That happens when the source is `unsuitable` and the format is promotional (`PROMOTIONAL_FORMATS = PROMO, AD, CAMPAIGN_COPY`). For a non-clear source in other formats, `safetyInstructions()` goes into the prompt before any variation instructions.
5. **Brand voice.** `generateBrandVoiceProfile()` ensures a profile exists (feature 04). `loadWritingContext()` in `server/content/quality.service.ts` builds the system prompt: voice, writing rules and `policyToPrompt()` compliance rules.
6. **Version count.** `n = 1` for `BLOG`; otherwise `min(3, max(1, variations))`.
7. **Context package** (`assembleDraftContext`, then `assembleGenerationContext`); see 3.4.
8. **The prompt** is built from:
   - a task line naming the audience and the channel ("...for X, to run on LinkedIn")
   - `formatInstructions()`: format, where it goes, length, CTA (the destination is the brief's, else the company website, else "no link is known"), and voice in this format
   - optional `TONE_GUIDANCE`
   - the `SOURCE_FIDELITY` block ("STAY ON THE SOURCE MATERIAL")
   - the safety rules
   - the variation angles (`VARIATION_ANGLES`) when n > 1
   - the context text
   - the exact JSON output shape
9. **Model call.** `completeStructured()` with the format's zod schema (`aiBodySchemaFor`), which excludes `details`:
   - `maxTokens`: 4,000 for BLOG, 2,200 for CAMPAIGN_COPY, 1,600 otherwise, multiplied by n
   - `effort`: `high` for BLOG, `medium` otherwise
   - the prompt version is recorded as `PROMPT_VERSION = 's9.source-fidelity-safety'`
10. **Check and repair** (`checkAndRepair`, run in parallel per version). `finalizeBody()` applies `checkQuality()` and `applySafeFixes()`. When there are blocking issues (other than `details-unconfirmed`), a single repair call gets the issues (`issuesAsFeedback`) and the safety rules. If the repair fails, the first draft is kept with its issues.
11. **Persist.** `db.contentDraft.create` with `status: DRAFT`, `platform` (null for EMAIL) and `aiMetadata` (see section 5). It also seeds `approval` (`generatedRecord`), `versions` (`firstVersion`) and `trace` (`initialTrace`), which feature 13 owns.
12. **Audit.** `CONTENT_DRAFT_CREATED` records the type, source, platform, number of variations, `approvable` and `repaired`.
13. **Review.** `reviewAfterWrite(draft, 'generated')` runs the AI Reviewer straight away. If the reviewer breaks, the draft is still saved and is reviewed again on submit.

Autopilot (`server/briefing/autopilot.service.ts`) and the campaign executor (`server/campaigns/executor.service.ts`) call the same `generateDraft()`; autopilot passes `userId: null`.

### 3.4 Generation context (lib/generation-context.ts)

- **14 sections** (`CONTEXT_SECTIONS`) in priority order. `brief`, `business` and `channel` are required.

  | Section | Max tokens |
  | --- | --- |
  | `brief` | 600 |
  | `business` | 450 |
  | `channel` | 400 |
  | `recommendation` | 450 |
  | `opportunity` | 150 |
  | `goal` | 150 |
  | `audience` | 150 |
  | `voice` | 250 |
  | `memory` | 150 |
  | `reference` | 700 |
  | `knowledge` | 900 |
  | `previousContent` | 250 |
  | `recentTopics` | 100 |
  | `assumptions` | 120 |

- **Budget.** `CONTEXT_TOKEN_BUDGET = 3200`, with tokens estimated as characters / 4 (`estimateTokens`). Required sections are trimmed but never dropped. Optional sections are added by priority, each trimmed to its cap and to what is left. Once fewer than 60 tokens remain, the rest are dropped with "Over the context budget."
- **Current business.** It comes from `getContextSnapshot(companyId, { view: 'content' })`, which rebuilds when the source stamp changes (feature 05).
- **Relevance.** A knowledge passage must share at least two whole topic words (`topicWords` / `overlap`). Earlier posts must be `APPROVED` or `PUBLISHED` within `PREVIOUS_WINDOW_DAYS = 120` and share topic words. Memory patterns about other topics, formats or channels are dropped, as are campaigns the piece is not for. Each drop is recorded in `dropped` with its reason.
- **Redaction** (`redactSensitive`) covers the kinds `email`, `phone`, `secret`, `card` and `id`:
  - Always removed: secrets and tokens, `key=value` passwords, connection strings, secret URL parameters, Luhn-valid card numbers, and internal cuid-style ids (`/\bc[a-z0-9]{24}\b/`).
  - Removed from documents, pages and earlier posts: email addresses not on the business's own domain, and phone numbers.
  - Counts per kind go into `redactions`.
- **Trace.** `generationContextRecord()` stores the trace and shape (not the text) in `aiMetadata.context`:
  - the recommendation, opportunity and brief version
  - the snapshot fingerprint and revision
  - the knowledge chunk ids and earlier posts used
  - the reference URLs
  - the sections, drops, redactions and budget

### 3.5 Formats (lib/content-formats.ts + lib/validations/content.ts)

| Type | Family | Publishing | CTA mode | Output (zod limits) |
| --- | --- | --- | --- | --- |
| `LINKEDIN_POST` | social_post | network | required | hook <= 300, 3 to 5 paragraphs <= 1,200, cta <= 300, up to 8 hashtags |
| `IMAGE_POST` | caption | network | required | caption <= 2,200, cta, up to 12 hashtags, altText <= 420 |
| `CAROUSEL` | carousel | network | required | title <= 160, 5 to 8 slides (headline <= 120, body <= 400), cta, up to 8 hashtags |
| `TWEET_THREAD` | thread | network | optional (inline in the last tweet) | 2 to 12 tweets <= 280, up to 3 hashtags |
| `BLOG` | article | copy_out | optional | headline <= 200, subtitle <= 300, 2 to 10 sections (heading <= 160, body <= 4,000), up to 10 tags |
| `EMAIL` | email | copy_out | required | subjectLine <= 120, previewText <= 160, greeting <= 80, 1 to 6 paragraphs <= 1,500, cta, signOff <= 160 |
| `AD` | ad | copy_out | required | headline <= 80, primaryText <= 1,000, description <= 120, cta <= 40 (default "Learn more") |
| `CAMPAIGN_COPY` | campaign_copy | copy_out | required | tagline <= 80, keyMessage <= 300, shortCopy <= 280, longCopy <= 1,200, up to 4 proofPoints <= 200, cta |
| `PROMO` | promotional_copy | copy_out | required | headline <= 80, offer <= 200, body <= 800, terms <= 300, urgency <= 120, cta |

`COPY_ONLY_TYPES` (EMAIL, AD, CAMPAIGN_COPY and PROMO) are never published to a network. `ctaRequired()` returns true for `required` formats, and for `optional` ones when the brief expects a CTA (never for a thread).

**Copy limits** (`lib/content-playbook.ts`; soft is the "aim for" length, hard is the limit at which the destination truncates or rejects):

| Scope | Soft | Hard | Max hashtags |
| --- | --- | --- | --- |
| TWEET_THREAD | 1,680 (280 x 6) | 3,360 (280 x 12) | 2 |
| BLOG | 12,000 | 40,000 | 10 |
| EMAIL | 2,000 | 6,000 | 0 |
| AD | 400 | 1,200 | 0 |
| CAMPAIGN_COPY | 1,600 | 2,400 | 0 |
| PROMO | 700 | 1,300 | 0 |
| Other formats on X | 240 | 280 | 2 |
| on Instagram | 1,000 | 2,200 | 8 |
| on Facebook | 600 | 5,000 | 2 |
| on LinkedIn | 1,500 | 3,000 | 5 |

### 3.6 Deterministic quality rules (lib/content-quality.ts)

`checkQuality()` returns a `QualityReport` with issues of severity `block` or `warn`, plus `approvable`. Issue codes:

- `too-long` and `long`
- `hashtags`
- `no-cta`
- `alcohol-minors`, `alcohol-driving`, `alcohol-excess`, `alcohol-health` and `alcohol-social` (only for an alcohol business, `isAlcoholBusiness`; `RESPONSIBLE_LINE = "Please enjoy responsibly."`)
- `avoid-topic` (the voice's never-mention list)
- `unsupported-claim` and `unsupported-number` (against the grounding sources, including recommendation evidence)
- `robotic-phrase` and `repetition` (`ROBOTIC_PHRASES`)
- `source-tone-mismatch`, a blocker raised by `toneMismatch()` when the source is not clear and the copy uses promotional phrases
- `details-unconfirmed`: a post detail typed for this post rather than taken from the business profile

`transition()` refuses approval while any `block` issue remains (409 "Fix before approving: ...").

### 3.7 Fact check (lib/fact-check.ts)

1. `extractClaims()` finds claim kinds `number`, `date`, `absolute` ("the only", "award-winning", "guaranteed", "#1", "certified"), `business` ("we ..."), `market` and `contact`. Questions and CTAs are skipped.
2. `checkFacts()` compares the claims against trusted sources: snapshot confirmed facts, recommendation evidence (with the date it was seen), the business's own documents and the person's brief. Assumptions are kept apart as untrusted.
3. Each claim gets a status:
   - `supported`
   - `contradicted`: a different percentage, price or year about the same thing
   - `unsupported`
   - `unverified`: only an assumption backs it
   - `outdated`: backed only by evidence older than `OUTDATED_AFTER_DAYS = 180`, or marked stale, for market, date and number claims
4. `mustFix` is set for contradicted claims and for unsupported figures or absolutes. The report is verified only when every claim is supported.
5. `factCheckDraft()` (`server/content/fact-check.service.ts`) recomputes the check on every draft-page load and at approval, so it is never stale.
6. At approval:
   - a contradicted claim returns 409 `facts_contradicted`
   - a must-fix claim returns 409 `facts_must_fix`
   - `needs_review` without `factsReviewed: true` returns 409 `facts_need_review`

### 3.8 Compliance policy (lib/compliance-policy.ts)

- The policy is stored in `Company.preferences.compliancePolicy` and validated with `compliancePolicySchema` (`POLICY_VERSION = 1`).
- `defaultPolicy(alcohol)` applies until the workspace saves its own:
  - the general pack is on
  - alcohol follows the business automatically
  - "Terms apply." is required on promotions (`promo-terms`)
  - "Please enjoy responsibly." is required for alcohol businesses (`responsible-drinking`)
  - competitor mentions and giveaways go to a person
- **Packs** (`PACKS`): `general`, `alcohol`, `health` and `financial`. Examples from the general pack: `general.risk-free` (fail), `general.miracle` (fail) and `general.guarantee` (review). `CHANNEL_RULES` apply to every workspace.
- **Categories** (`COMPLIANCE_CATEGORIES`): `prohibited_claim`, `disclaimer`, `channel`, `business`, `cta`, `factual` and `manual_review`.
- **Findings.** Each has outcome `fail`, `review` or `warn`, a stable `ruleId`, the sentence it is about, a fix and a source (`built_in`, `workspace`, `rules` or `fact_check`).
- `checkCompliance()` runs inside the AI Reviewer, where findings feed the review dimensions. A `fail` fails the review. `policyToPrompt()` gives the same rules to the writer.
- `policyHash(policy, alcohol)` fingerprints the rules. A review made under other rules is out of date (`isReviewCurrent`).

### 3.9 AI Reviewer (lib/content-review.ts, server/content/review.service.ts)

- **Model call.** It is independent: `REVIEWER_SYSTEM`, which never sees the writer's prompt, and `buildReviewerPrompt()`. The call is `completeStructured` with tier `standard`, `effort: 'low'`, `maxTokens: 2500`, `timeoutMs: REVIEW_TIMEOUT_MS = 25_000` and `maxAttempts: 1`.
- **Inputs.** The finished piece, format and channel limits, business, audience and goal, brand voice, the recommendation and brief, facts (knowledge capped at 3,000 characters, redacted), whether alcohol rules apply, and the stored `sourceMaterial` (capped at 4,000 characters) with the safety warning placed before it.
- **Output.** `reviewerOutputSchema` returns 1 to 5 scores per dimension, issues (`blocker` / `major` / `minor`) and a summary. It has no copy field, and quotes are kept only if they appear in the piece.
- **Dimensions and weights.** There are 11 (`REVIEW_DIMENSIONS`); the critical ones are marked:

  | Dimension | Weight | Critical |
  | --- | --- | --- |
  | relevance | 1 | |
  | accuracy | 1.5 | yes |
  | brand_voice | 1 | |
  | audience_fit | 1 | |
  | channel_fit | 0.75 | |
  | clarity | 1 | |
  | cta | 0.75 | |
  | completeness | 0.75 | |
  | recommendation_alignment | 1 | |
  | compliance | 1.5 | yes |
  | brand_safety | 1.5 | yes |

  For critical dimensions the model alone can only send a piece to review, never fail it; only the rules, the fact check and the policy fail them.
- **Thresholds** (`REVIEW_THRESHOLDS`):

  | | Dimension | Overall |
  | --- | --- | --- |
  | Pass | >= 75 | >= 70 |
  | Fail | < 50 | < 50 |
- **Combining.** `combineReview()` merges the signals from the reviewer, the `rules` (quality), the `fact_check` and the `policy`. The result is stored in `aiMetadata.review` with `bodyHash`, `trigger` (`generated`, `regenerated`, `manual`, `submitted` or `approval`), `durationMs`, `thresholds` and later `acknowledgedBy`. The previous 5 reviews are kept in `aiMetadata.reviewHistory`.
- **Enforcement** in `transition()`, where `ensureReview()` re-reviews a stale review first:
  - `fail` blocks submit and approve (409 `review_failed`)
  - `review_required` blocks approval without `reviewAcknowledged` (409 `review_needs_human`)
- **Fix.** `POST /refine { action: 'fix_review' }` feeds the stored review's issues (`reviewAsFeedback`) to the writer.

### 3.10 Rewrites, undo and variations

- **Refine** (`POST .../refine`, `refineDraft`). Actions: `regenerate`, `shorten` (about 40% shorter), `expand`, `tone`, `improve`, `custom` (feedback up to 1,000 characters) and `fix_review`.
  - The refine prompt includes knowledge capped at 6,000 characters, redacted.
  - The result goes through `checkAndRepair`, and the draft returns to `DRAFT`.
  - The previous body is pushed into `aiMetadata.history`, which keeps up to 5 entries (`HISTORY_LIMIT = 5`) for **Undo**.
  - The update is guarded by `updatedAt`; a concurrent change returns 409 `concurrent_change`.
  - Published drafts cannot be refined (409).
- **Variations** (`POST .../variations { kind, tone?, platform? }`, `createVariation`). `VARIATION_KINDS` are `shorter`, `longer`, `tone`, `cta`, `headline`, `channel` and `image`; `availableVariations()` gates them by format and platform.
  - `cta` and `headline` change one field in code (`withField`, with `FIELD_MAX` limits: hook 300, title 160, headline 80, subjectLine 120, tagline 80, cta 300).
  - `image` returns a request to post to the graphics route (feature 12).
  - Other kinds are written with `preserveInstructions()`: keep the goal, audience, key message, evidence, CTA destination and brand.
  - **Facts guardrail.** `findIntroducedFacts()` treats any number, price, percentage, date, link, email or handle that is in neither the original nor the brief as changed. The version gets one correction pass; if it still changes a fact, it gets the blocking issue `facts-changed`.
  - **Topic guard.** `topicOverlap()` below `TOPIC_DRIFT_FLOOR = 0.3` gives the blocking issue `topic-drift`. The overlap takes the better of both directions, so shortening is not punished.
  - Versions live in `aiMetadata.variations`, up to `MAX_VERSIONS = 8`; the oldest unused versions are dropped first, never the active one. The route is rate-limited to 20 per minute per user.
- **Switch version** (`POST .../variation { index }`, `switchVariation`) is undoable. The version being left is saved as it reads.
- **Version workspace** (`server/content/version-workspace.service.ts`, routes `.../variations/[index]/*` and `.../variations/more`):
  - edit one version's fields or CTA (`PATCH`, 60 per minute)
  - rewrite one version (20 per minute)
  - revert it to its `previous` text (60 per minute)
  - suggest CTAs (`cta-options`, 20 per minute). Nothing is saved, and suggestions that introduce an unknown link, number, price or date are dropped.
  - add up to `MAX_MORE = 3` more versions (`more`, 20 per minute, default 2)

  The active version is the draft body, so changes to it go through `updateDraftBody` / `refineDraft` and require re-approval. `versionIndex()` accepts 0 to 7.

### 3.11 Status changes from Content Studio

`server/content/content.service.ts` holds the state machine (`TRANSITIONS`):

| From | Allowed next statuses |
| --- | --- |
| `DRAFT` | `PENDING_APPROVAL`, `REJECTED` |
| `PENDING_APPROVAL` | `APPROVED`, `REJECTED`, `DRAFT` |
| `APPROVED` | `PUBLISHED`, `DRAFT`, `REJECTED` |
| `REJECTED` | `DRAFT` |
| `PUBLISHED` | none (terminal) |

- `PUBLISHED` is reachable only from `APPROVED`.
- `POST .../status` maps `submit`, `approve`, `reject` and `request_changes` onto these transitions.
- `POST /api/content/drafts/bulk` approves or rejects 1 to 100 drafts with a 45-second deadline (`bulkTransition`).
- Manual edits (`PATCH /api/content/drafts/:id`, `updateDraftBody`) are validated per type. `baseUpdatedAt` guards them (409 `stale`), and an approved draft goes back to draft.

The approval model built on this machine is described in [13](../13-review-approval-versions-and-trace/).

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Page | `app/dashboard/content/page.tsx` | Board of drafts by status, create dialog |
| Page | `app/dashboard/content/new/page.tsx` | Server shell resolving enabled formats, `?rec=` creation plan and brief input |
| Page | `app/dashboard/content/[id]/page.tsx` | Draft page: preview, versions, review, fact check, graphics, composer, actions |
| Page | `app/dashboard/content/calendar/page.tsx` | Month calendar of drafts, scheduled and published content |
| Page | `app/dashboard/settings/compliance/page.tsx` | Settings -> Compliance |
| Component | `components/dashboard/content/new-content-form.tsx` | Generate form (brief / trend / recommendation), idempotency key, accept-then-write |
| Component | `components/dashboard/content/create-content-dialog.tsx` | Modal to write from a brief or campaign |
| Component | `components/dashboard/content/content-brief-panel.tsx` | Shows the Content Brief, missing fields and fixes, live validation |
| Component | `components/dashboard/content/generation-options.tsx` | Network, number of versions, tone |
| Component | `components/dashboard/content/creation-notice.tsx` | Shown when a recommendation has nothing to write |
| Component | `components/dashboard/content/created-from-suggestion.tsx` | Which suggestion, why, evidence (from `draftContext`) |
| Component | `components/dashboard/content/queue-board.tsx` | Status columns with per-column empty copy |
| Component | `components/dashboard/content/draft-preview.tsx` | Per-format preview; invalid bodies fail closed |
| Component | `components/dashboard/content/version-workspace.tsx` | All versions side by side with per-version edit, rewrite, revert, CTA |
| Component | `components/dashboard/content/content-assistant-panel.tsx` | Writing assistant: rewrites, variations, versions, context |
| Component | `components/dashboard/content/review-panel.tsx` | AI Reviewer result, Review again, Regenerate with review feedback |
| Component | `components/dashboard/content/fact-check-panel.tsx` | Claims and their status |
| Component | `components/dashboard/content/draft-actions.tsx` | Submit / approve / reject / request changes |
| Component | `components/dashboard/content/brand-voice-card.tsx` | Brand voice summary card |
| Component | `components/dashboard/content/post-composer.tsx`, `multi-publish.tsx`, `execution-readiness.tsx` | Queue, multi-network publish, execution readiness (behaviour in feature 20) |
| Component | `components/dashboard/content/graphic-studio.tsx`, `creative-studio.tsx`, `visual-brief-panel.tsx`, `image-variant-panel.tsx`, `agnes-image-generator.tsx` | Image and creative UI (feature 12) |
| Component | `components/dashboard/settings/compliance-form.tsx` | Compliance policy editor and Try the rules |
| API | `app/api/content/generate/route.ts` | Generate a draft (see 3.2) |
| API | `app/api/content/drafts/[id]/route.ts` | Get / edit a draft, retarget platform |
| API | `app/api/content/drafts/[id]/refine/route.ts`, `undo/route.ts`, `variation/route.ts` | Rewrites, undo, switch version |
| API | `app/api/content/drafts/[id]/variations/**` | Variations and the per-version workspace (`_shared.ts` holds auth, rate limit, index) |
| API | `app/api/content/drafts/[id]/review/route.ts` | Read / run the AI Reviewer |
| API | `app/api/content/drafts/[id]/status/route.ts`, `drafts/bulk/route.ts` | Status transitions |
| API | `app/api/company/compliance/route.ts` | Read / save / reset / test the compliance policy |
| Service | `server/content/generator.ts` | `generateDraft`, `checkAndRepair`, `refineDraft`, `switchVariation`, `undoDraft`, reference fetch, brief resolution |
| Service | `server/content/content.service.ts` | State machine, `transition`, `bulkTransition`, `updateDraftBody`, `listDrafts`, `getDraft`, schedule/queue helpers |
| Service | `server/content/content-brief.service.ts` | `getBriefInput`, `getContentBrief` |
| Service | `server/content/generation-context.service.ts` | `assembleDraftContext` (snapshot, knowledge, earlier posts, memory) |
| Service | `server/content/quality.service.ts` | `loadWritingContext`, `writingPlatform`, `qualityContextFor`, `finalizeBody`, `chunkText`, `assessDraft` |
| Service | `server/content/review.service.ts` | `reviewDraft`, `ensureReview`, `reviewAfterWrite`, `storedReview`, `currentReview`, `missingParts` |
| Service | `server/content/fact-check.service.ts` | `factCheckDraft` |
| Service | `server/content/compliance.service.ts` | `getPolicyContext`, `saveCompliancePolicy`, `resetCompliancePolicy` |
| Service | `server/content/variations.service.ts` | `createVariation`, `preserveContextFor`, `imageVariationRequest`, `VariationError` |
| Service | `server/content/version-workspace.service.ts` | `versionsOf`, `editVersion`, `revertVersion`, `rewriteVersion`, `addRecommendations`, `ctaOptions`, `setVersionCta` |
| Service | `server/content/audience.ts` | Business and audience profiles for prompts (`audienceToPrompt`, `contentRulesFor`) |
| Service | `server/content/render.ts` | `renderForManual` (copy-out text), `renderLinkedInCommentary` |
| Service (other features) | `server/content/brand-voice.service.ts` (04); `publish.service.ts`, `multi-publish.service.ts`, `publication-store.ts`, `processing.service.ts` (20) | Brand voice profile; publishing |
| Lib | `lib/content-brief.ts` | Brief schema, field policy, `buildContentBrief`, `validateContentBrief`, `briefText`, `briefPrompt`, `briefToContentRequest` |
| Lib | `lib/generation-context.ts` | Sections, budget, redaction, relevance, `assembleGenerationContext`, `generationContextRecord` |
| Lib | `lib/content-formats.ts` | `FORMAT_SPECS`, `FORMAT_FAMILIES`, `ctaRequired`, `formatInstructions` |
| Lib | `lib/content-playbook.ts` | Per-format and per-network rules and `CopyLimits`, `ROBOTIC_PHRASES`, `TONE_GUIDANCE`, `VARIATION_ANGLES` |
| Lib | `lib/content-quality.ts` | `checkQuality`, `applySafeFixes`, `copyParts`, `issuesAsFeedback`, alcohol code |
| Lib | `lib/content-review.ts` | Dimensions, thresholds, reviewer prompt and schema, `combineReview`, `bodyHash`, `isReviewCurrent` |
| Lib | `lib/content-variations.ts` | Variation kinds, preserve rules, facts and topic checks, version list |
| Lib | `lib/fact-check.ts` | `extractClaims`, `checkFacts`, `claimsToReview` |
| Lib | `lib/compliance-policy.ts` | Policy schema, packs, channel rules, `checkCompliance`, `policyToPrompt`, `policyHash` |
| Lib | `lib/brand-safety.ts` | `classifySource`, `toneMismatch`, `refusalFor`, `safetyInstructions`, `anglePolicyFor`, `storedSourceSafety` |
| Lib | `lib/post-details.ts` | Post details schema, `detailProblem`, `unconfirmedDetails`, `normaliseDetails` |
| Lib | `lib/platforms.ts` | `PLATFORM_SPECS`, `ASPECT_RATIOS`, `RATIO_DIMENSIONS`, `defaultPlatformFor`, `platformsForType` |
| Lib | `lib/draft-context.ts` | Reads `aiMetadata.brief` / `recommendation` loosely for later steps |
| Lib | `lib/content-ui.ts` | Type and status labels, `draftSnippet` |
| Lib | `lib/validations/content.ts` | Body schemas per format, generate / refine / update / reject / schedule schemas |
| Tests | `tests/content-brief.test.ts`, `generation-context.test.ts`, `format-specs.test.ts`, `content-formats.test.ts`, `content-quality.test.ts`, `content-review.test.ts`, `content-variations.test.ts`, `fact-check.test.ts`, `compliance-policy.test.ts`, `brand-safety.test.ts`, `post-details.test.ts`, `platforms.test.ts`, `draft-context.test.ts`, `content-schemas.test.ts`, `content-audience.test.ts`, `content-queue.test.ts`, `heuristic-prompt-brand.test.ts` | Unit tests (vitest) |

## 5. Data model

**`ContentDraft`** (`prisma/schema.prisma`) is the main record:

| Field | Notes |
| --- | --- |
| `id`, `companyId`, `createdById?`, `campaignId?` | Workspace-scoped. `createdById` is null for autopilot drafts. |
| `type` | `ContentType`: `LINKEDIN_POST`, `CAROUSEL`, `TWEET_THREAD`, `BLOG`, `IMAGE_POST`, `EMAIL`, `AD`, `CAMPAIGN_COPY`, `PROMO` |
| `status` | `ContentStatus`: `DRAFT` (default), `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `PUBLISHED` |
| `title`, `body` (Json) | The body is structured per type (section 3.5) and may carry `details` (post details). |
| `aiMetadata` (Json) | See below |
| `rejectionReason`, `scheduledFor`, `publishedAt`, `publishedUrl` | Lifecycle fields |
| `platform` | `SocialPlatform?`. Null means `defaultPlatformFor(type)`. |
| Relations | `company`, `createdBy`, `campaign`, `media` (`ContentMedia[]`), `generatedAssets`, `publications` (`ContentPublication[]`), `executionHandoffs`, `executions`, `performanceSnapshots` |
| Indexes | `[companyId, status]`, `[companyId, scheduledFor]`, `[companyId, updatedAt]` (board sort), `[campaignId]` |

**`aiMetadata` keys written by this feature:**

| Key | Contents |
| --- | --- |
| `source` | `{ kind, ref, brief }` |
| `recommendation`, `brief` | Provenance and the Content Brief as validated |
| `model`, `promptVersion` | e.g. `s9.source-fidelity-safety` |
| `contextRevision`, `knowledgeChunkIds`, `context` | Generation context trace |
| `brandVoiceApplied`, `sourceSafety`, `sourceMaterial` | `sourceMaterial` is capped at 4,000 characters |
| `referenceUsed`, `writtenFor`, `tone`, `campaignId` | |
| `quality` | The `QualityReport` |
| `variations`, `activeVariation` | Versions, up to 8 |
| `history`, `lastAction` | Undo stack, up to 5 entries |
| `review`, `reviewHistory` | `ContentReview` plus the previous 5 |
| `idempotencyKey` | |

The `approval`, `versions` and `trace` keys are seeded here, but feature 13 owns them.

**Other models used:**

- `Company.preferences.compliancePolicy` (Json): the compliance policy.
- `Company` / Business Context Snapshot (feature 05).
- `KnowledgeChunk` (feature 04): knowledge passages.
- `Recommendation` / `Opportunity` (features 08 and 09).
- `Campaign` (feature 14).
- `AuditLog`, using the actions `CONTENT_DRAFT_CREATED`, `CONTENT_REGENERATED` and `COMPANY_UPDATED` (section `compliancePolicy`) plus the status-change actions.

## 6. API endpoints

Full reference: [Internal API](../../04-api/INTERNAL-API.md). Every route uses `requireActiveCompany()` and is scoped to the active workspace; another workspace's draft returns 404.

| Method | Path | Purpose | Auth/permission |
| --- | --- | --- | --- |
| POST | `/api/content/generate` | Write a new draft (1 to 3 versions) from a brief, trend, campaign or recommendation | `content:create` |
| GET | `/api/content/drafts/:id` | One draft | member of workspace |
| PATCH | `/api/content/drafts/:id` | Save a manual edit (`body`, `title`, `baseUpdatedAt`) or retarget `platform` | `content:create` |
| POST | `/api/content/drafts/:id/refine` | One-click rewrite (`action`, `tone?`, `feedback?`) | `content:create` |
| POST | `/api/content/drafts/:id/undo` | Restore the version before the last rewrite, switch or edit | `content:create` |
| POST | `/api/content/drafts/:id/variation` | Switch to version `{ index }` | `content:create` |
| POST | `/api/content/drafts/:id/variations` | Make a variation `{ kind, tone?, platform? }` | `content:create`, 20/min |
| POST | `/api/content/drafts/:id/variations/more` | Add 1 to 3 more versions from unused angles | `content:create`, 20/min |
| PATCH | `/api/content/drafts/:id/variations/:index` | Save one version's `body` or `cta` | `content:create`, 60/min |
| POST | `/api/content/drafts/:id/variations/:index/rewrite` | Regenerate or refine one version `{ instruction? }` | `content:create`, 20/min |
| POST | `/api/content/drafts/:id/variations/:index/revert` | Restore one version's previous text | `content:create`, 60/min |
| POST | `/api/content/drafts/:id/variations/:index/cta-options` | Suggested CTAs (nothing saved) | `content:create`, 20/min |
| GET | `/api/content/drafts/:id/review` | Stored review and whether it is current | member of workspace |
| POST | `/api/content/drafts/:id/review` | Review the draft now | `content:create` |
| POST | `/api/content/drafts/:id/status` | `submit` / `approve` / `reject` / `request_changes` (`factsReviewed?`, `reviewAcknowledged?`) | `content:create`; approve and reject need `content:approve` |
| POST | `/api/content/drafts/bulk` | Approve or reject up to 100 drafts | `content:approve`, checked per draft |
| GET | `/api/company/compliance` | The policy context: `policy`, `alcohol`, `hash`, `customised`, `website` | member of workspace |
| PUT | `/api/company/compliance` | Save the policy (validated, audited) | `company:update` |
| POST | `/api/company/compliance` | `{ action: 'reset' }` (needs `company:update`) or `{ action: 'test', type, platform?, text <= 10,000, cta?, policy? }` | test: any member |

Also under `/api/content/drafts/:id` but documented elsewhere:

- `graphics`, `graphics/prompt`, `creative`, `creative/render`: feature 12
- `trace`: feature 13
- `publish`, `publications`, `schedule`, `queue`, `execution`: feature 20

## 7. External services

| Service | Used for | Env vars |
| --- | --- | --- |
| Anthropic (preferred) or Google Gemini, through `server/ai/claude.ts` (`completeStructured`) | Writing (premium tier), repair passes, rewrites, variations, CTA suggestions, the AI Reviewer (standard tier) | `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY`; tier overrides `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_CHEAP` / `_STANDARD` / `_PREMIUM`, `GEMINI_MODEL`, `GEMINI_MODEL_CHEAP` / `_STANDARD` / `_PREMIUM` |
| Public web pages | Reference pages linked in the brief, fetched with `politeFetchHtml` (up to 2 pages, 4,000 characters each) | none |

The default models are `claude-sonnet-5` for the standard tier and `gemini-3.5-flash-lite` for Gemini's standard and premium tiers (see [23-ai-layer](../23-ai-layer/)). See [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

Content Studio has no cron of its own. Two background callers use `generateDraft()`:

- Autopilot (`server/briefing/autopilot.service.ts`, feature 10)
- The campaign executor (`server/campaigns/executor.service.ts`, feature 14)

Scheduled publishing (`runScheduledPublishes`, `/api/cron/publish`) and finishing processing publications (`advanceProcessing`) live in `server/content/` but belong to [20-publishing-execution-and-scheduling](../20-publishing-execution-and-scheduling/).

## 9. Security & permissions

- **RBAC** (`lib/rbac.ts`):
  - `content:create` (OWNER, ADMIN and MEMBER) for generating and changing content
  - `content:approve` for approve and reject, enforced in `transition()` and not only in the route
  - `content:publish` for publishing and scheduling
  - `company:update` for compliance policy changes
  - VIEWER has no permissions
- **Workspace scoping.** Every query is filtered by `companyId`. Recommendations are resolved through `getCreation(company.id, ...)`, so another workspace's id is treated as gone, never trusted. The brief service returns null for another workspace's recommendation.
- **Validation.** Zod covers every input (`generateContentSchema`, `refineContentSchema`, `updateDraftSchema`, per-type body schemas, `compliancePolicySchema`). The AI's output is validated against the format's schema, which excludes post details, so the model can never write contact details.
- **Concurrency.** Writes use optimistic concurrency (`updatedAt` guard, `baseUpdatedAt`): 409 `concurrent_change` / `stale`.
- **Idempotency** keys on generate prevent paying for a duplicate draft.
- **Redaction.** Data sent to the model is redacted (section 3.4). Leads, contacts, connections, credentials and performance data are never read into the context.
- **Approval gates.** No draft enters approval with a failed review, and none is approved while it has blocking quality issues, a contradicted or must-fix claim, unconfirmed claims or human-review flags that have not been acknowledged. `PUBLISHED` is reachable only from `APPROVED`.
- **Brand safety.** Promotional formats are refused on `unsuitable` sources (422 `source_not_marketable`, audited).
- **Rate limits.** Variation and version routes are limited per user (`lib/rate-limit.ts`); see section 6.
- **Audit.** Draft creation (including refusals), regeneration, status changes and compliance policy saves are audited.

## 10. Testing

**Unit tests** (`pnpm test`, vitest), in `tests/`:

| File | What it covers |
| --- | --- |
| `content-brief.test.ts` | The Content Brief |
| `generation-context.test.ts` | Context assembly |
| `format-specs.test.ts`, `content-formats.test.ts` | Format definitions |
| `content-schemas.test.ts` | Body schemas |
| `content-quality.test.ts` | Quality rules |
| `content-review.test.ts` | The AI Reviewer |
| `content-variations.test.ts` | Variations |
| `fact-check.test.ts` | The fact check |
| `compliance-policy.test.ts` | Compliance |
| `brand-safety.test.ts` | Brand safety |
| `post-details.test.ts` | Post details |
| `platforms.test.ts` | Platforms |
| `draft-context.test.ts` | Draft context |
| `content-audience.test.ts` | Audience |
| `content-queue.test.ts` | Queue |
| `heuristic-prompt-brand.test.ts` | Heuristic prompts and brand |

**Verify scripts** (run against the app, usually with `VERIFY_BASE_URL=http://localhost:3001`):

| Script | Covers |
| --- | --- |
| `pnpm verify:content-brief` | Recommendation -> Content Brief on the running app |
| `pnpm verify:generation-context` | Context assembly against the real DB and app |
| `pnpm verify:contextual-generation` | Every format written from an accepted recommendation |
| `pnpm verify:variations` | Variations with the model stubbed, including a changed fact |
| `pnpm verify:review` | AI Reviewer with stubbed writer and reviewer |
| `pnpm verify:compliance` | Policy checks, with the reviewer stubbed to 5/5 |
| `pnpm verify:fact-check` | Factual validation |
| `pnpm verify:content-control` | Multiple versions, per-version editing, CTA controls, image refinement, logo settings (AI stubbed) |
| `pnpm verify:content-studio` | End to end with the real AI writer on a throwaway alcohol brand |
| `pnpm verify:creation` | Recommendation -> creation hand-off |

## 11. Configuration & limits

| Setting | Value | Where |
| --- | --- | --- |
| Formats | 9; per-workspace enable list | `CONTENT_TYPES`, Settings -> Content formats |
| Versions per generate | 1 to 3 (BLOG: 1) | `generateContentSchema`, `generator.ts` |
| Source brief length | 2,000 characters | `generationSourceSchema`, `BRIEF_TEXT_LIMIT` |
| Refine feedback | 1,000 characters | `refineContentSchema` |
| Reject reason | 500 characters | `rejectDraftSchema` |
| Generation route budget | `maxDuration = 60` s | generate, review, variations, variations/more, rewrite (cta-options: 30 s) |
| Context budget | 3,200 tokens; drop the rest under 60 left | `CONTEXT_TOKEN_BUDGET` |
| Earlier-posts window | 120 days | `PREVIOUS_WINDOW_DAYS` |
| Reference pages | 2 pages, 4,000 characters each | `fetchReferenceContext` |
| Stored source material | 4,000 characters | `aiMetadata.sourceMaterial` |
| Writer max tokens | 1,600 (BLOG 4,000, CAMPAIGN_COPY 2,200) x versions | `maxTokensFor` |
| Repair passes | 1 | `checkAndRepair` |
| Reviewer | standard tier, 25 s timeout, 1 attempt, 2,500 max tokens | `REVIEW_TIMEOUT_MS` |
| Review thresholds | dimension pass >= 75, fail < 50; overall pass >= 70, fail < 50 | `REVIEW_THRESHOLDS` |
| Review history | 5 | `review.service.ts` |
| Undo history | 5 | `HISTORY_LIMIT` |
| Versions per draft | 8 | `MAX_VERSIONS` |
| More versions per call | 1 to 3 (default 2) | `MAX_MORE` |
| Topic drift floor | 0.3 | `TOPIC_DRIFT_FLOOR` |
| Outdated evidence | 180 days | `OUTDATED_AFTER_DAYS` |
| Bulk transition | 1 to 100 drafts, 45 s deadline | `drafts/bulk` |
| Board size | 200 drafts | `DRAFT_BOARD_LIMIT` |
| Compliance test text | 10,000 characters | `testSchema` |
| Platform image specs | LinkedIn: PNG/JPEG, 10 MB, default 1:1. Instagram: JPEG/PNG, 8 MB, default 4:5, media required. X: PNG/JPEG/WEBP, 5 MB, default 16:9. Facebook: PNG/JPEG, 8 MB, default 1:1 | `PLATFORM_SPECS` |

## 12. Known limitations & future work

- **Fixed brand-safety patterns.** Brand safety is deterministic pattern matching by design. Its own notes say it cannot read a story that is grim without grim words; the trend digest combines it with the model's judgement (feature 06), but Content Studio uses only the patterns.
- **Token estimate.** Token counts are an approximation (characters / 4), not a tokenizer count.
- **Best-effort repair.** The repair pass runs once. If it fails or still blocks, the draft is saved with its blocking issues and cannot be approved until it is edited or regenerated.
- **Reviewer outages.** If the reviewer times out (25 s) or the provider is at its limit, the piece goes to `review_required` rather than passing. Approvers then must acknowledge.
- **Copy-only formats.** Blog, email, ad, campaign copy and promo are copy-only: Aura gives the text to copy out and does not send emails or run ads.
- **Few fetched pages.** Only 2 reference pages are fetched, and JavaScript is not executed.
- **Hand-written variations doc.** `docs/CONTENT-VARIATIONS.md` does not describe the per-version workspace (edit, rewrite, revert, CTA options, more versions). Only this document and the route comments describe it.

## 13. Related documents

**Feature docs in `docs/`:**

- [Content Brief](../../../CONTENT-BRIEF.md)
- [Generation context](../../../GENERATION-CONTEXT.md)
- [Content formats](../../../CONTENT-FORMATS.md)
- [Content variations](../../../CONTENT-VARIATIONS.md)
- [Fact check](../../../FACT-CHECK.md)
- [AI Reviewer](../../../CONTENT-REVIEW.md)
- [Compliance](../../../CONTENT-COMPLIANCE.md)
- [Content quality & brand safety](../../../CONTENT-QUALITY-REVIEW.md)
- [Recommendation context handoff](../../../RECOMMENDATION-CONTEXT-HANDOFF.md)
- [Sprint 3 technical (Content Studio)](../../../SPRINT-3-TECHNICAL.md)
- [Product documentation](../../../PRODUCT-DOCUMENTATION.md)

**Related features:**

- [12 - Media, graphics & creatives](../12-media-graphics-and-creatives/)
- [13 - Review, approval, versions & trace](../13-review-approval-versions-and-trace/)
- [04 - Knowledge base & brand voice](../04-knowledge-base-and-brand-voice/)
- [05 - Business context](../05-business-context/)
- [09 - Recommendations & Aura Suggests](../09-recommendations-and-aura-suggests/)
- [20 - Publishing, execution & scheduling](../20-publishing-execution-and-scheduling/)
- [23 - AI layer](../23-ai-layer/)

**Architecture:** [02-ARCHITECTURE.md](./02-ARCHITECTURE.md)
