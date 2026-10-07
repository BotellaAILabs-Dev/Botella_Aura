# Recommendation Context Handoff

The data contract Sprint 9 uses to turn an **accepted** recommendation into a
contextual content or marketing brief. It is one versioned, validated payload
built from the recommendation and the Business Context, so a workflow never
reads the Recommendation model's internals and the model needs no redesign.

| Piece | Where |
| --- | --- |
| Contract: schema, missing-field policy, builder, validator, Content Studio mapping (pure) | [`lib/recommendation-context-handoff.ts`](../lib/recommendation-context-handoff.ts) |
| Loading (recommendation + Business Context) | [`server/recommendations/context-handoff.service.ts`](../server/recommendations/context-handoff.service.ts) → `getContextHandoff(companyId, id)` |
| API | `GET /api/recommendations/:id/handoff` → `{ handoff, contentRequest }` |
| Content Studio | `/dashboard/content/new?rec=<id>`: the brief is written from the handoff, and a panel shows what was passed and what is missing |
| Tests | [`tests/recommendation-context-handoff.test.ts`](../tests/recommendation-context-handoff.test.ts); `pnpm verify:context-handoff` (a real recommendation, end to end) |

---

## 1. The payload — version 1

Every value that does not come from the recommendation itself says where it
came from (`source`: `recommendation`, `business_profile`, `campaign`,
`brand_voice`, `marketing_memory`, `content_playbook`).

| Field | Contents | From |
| --- | --- | --- |
| `recommendationId` | The recommendation | Recommendation |
| `opportunityId` | Its originating opportunity | Recommendation |
| `status`, `accepted`, `type` | Where it stands | Recommendation |
| `business` | name, description, offerings, industry, website | Business Context (identity) |
| `goal` | `{ value, source }`: the business's own goals, else the goal of a campaign whose themes match the recommendation | Business Context |
| `audience` | `{ value, source }`: the recommendation's audience, else the business's stated buyer | Recommendation → Business Context |
| `channel` | channel, Content Studio format, social network, `publishing` (`aura` if connected, `manual` if not) | Recommendation + connections |
| `action` | title, action, steps, angle | Recommendation |
| `reason` | why (without the engine's evidence bookkeeping), confidence and its reason | Recommendation |
| `evidence` | label, detail, url, observedAt for each piece | Recommendation's retained evidence |
| `expectedOutcome` | outcome, metric | Recommendation |
| `cta` | `expected` (whether the format wants one), `guidance` (how it is written for this format and network), `destination` (`{ value, source }`; the business's own website only) | Content playbook + Business Context |
| `brandVoice` | summary, tone, phrases, topics to avoid, formatting | Brand voice profile |
| `memory` | learned patterns that bear on this piece, each with its confidence and **why it is relevant** (this channel, this format, this topic, or general performance). Low-confidence and stale patterns are left out | Marketing Memory |
| `missing` | What Aura does not have; see §2 | — |
| `readiness`, `blockedBy` | Whether it can go ahead; see §3 | — |
| `generatedAt` | When it was built | — |

`validateContextHandoff(payload)` checks any copy, whether stored or from
another service, against the schema and returns the paths that are wrong.

## 2. Missing-field behaviour — nothing is invented

A value Aura does not have is `null` and is listed in `missing`. Each entry
gives:
- `level`
- `behaviour`: what the writer does without it
- `fix`: where to add it

| Field | Level | Without it |
| --- | --- | --- |
| `business` (description and offerings both empty) | **required** | Any copy would be invented, so the handoff is **blocked** |
| `goal` | recommended | Works toward the expected outcome only, without naming a wider goal |
| `audience` | recommended | Speaks to the business's customers in general, without inventing a persona |
| `channel` | recommended | The person picks the format; nothing is assumed about the network |
| `evidence` | recommended | Makes no claims about the market, competitors or results |
| `cta` (expected, but no website) | recommended | Names the next step without a URL; no address is made up |
| `brandVoice` | recommended | Content Studio writes plainly and builds a voice from the materials on first use |
| `memory` | recommended | No "what has worked" claims |
| ids, action, reason, expected outcome | never missing | Guaranteed by the Recommendation model's own validation |

Fallbacks are labelled, never silent. An audience taken from the business
profile says `source: business_profile`; a goal taken from a campaign says
`source: campaign`.

## 3. Readiness

| Readiness | When |
| --- | --- |
| `ready` | Accepted, nothing blocking, nothing missing |
| `ready_with_gaps` | Accepted and nothing blocking; recommended fields missing (stated in `missing`) |
| `blocked` | Not accepted yet ("Accept or edit it first"), already answered another way (skipped, rejected, expired…), a blocker other than low confidence (a channel the business doesn't use), or a required field missing |

Accepting a low-confidence recommendation is its review, so low confidence
alone never blocks an accepted one.

## 4. Preserving the recommendation id

- **Every link:** the id travels as `?rec=<id>` on every link
  ([AURA-MODULES.md](AURA-MODULES.md)).
- **The handoff:** `recommendationId` is in the payload and in the Content
  Studio request.
- **The draft:** each draft written for it stores
  `aiMetadata.recommendation = { id, title, handoff: { version, readiness,
  missing } }`, so the gaps stay visible after the draft is written.
- **The recommendation's history:** gets a `link` entry with the module and
  what was made.
- **Ids from clients:** only used if they belong to the workspace.

## 5. Content Studio integration

- `handoffToContentRequest(handoff)` returns the generation request, already
  validated against Content Studio's own `generateContentSchema`: `type`,
  `platform`, `source: { kind: 'BRIEF', brief }`, `recommendationId`. Sprint 9
  can post it to `/api/content/generate` as it is. It is `null` when the
  handoff is blocked or names no format.
- `handoffBrief(handoff)` is the brief, within Content Studio's 2,000-character
  limit. If it runs long, steps and learned patterns are dropped first; the
  title, why, expected outcome and CTA stay. Content Studio already reads the
  business, audience, goals, brand voice and learned patterns from the
  Business Context on every draft, so the brief carries what only the
  recommendation knows:
  - the action, steps and angle (said once)
  - the audience and why
  - the business goal and expected outcome
  - the evidence ("cite only this")
  - the CTA requirement
  - what has worked
  - **"Not provided — do not invent: …"** for each gap
- **On the page:** opening `/dashboard/content/new?rec=<id>` writes the brief
  from the handoff and preselects its format. A panel shows its readiness,
  what was passed to the writer, and each missing part with what that means
  and where to add it.

## Acceptance criteria

| Criterion | How |
| --- | --- |
| Sprint 9 can consume the recommendation without redesigning the Recommendation model | A versioned, validated payload built from the existing model and Business Context, with an API, a server function, a validator and a ready-made Content Studio request |
| All relevant context can be passed into content creation | All 13 fields the ticket lists, each with its source; the brief and request carry them into Content Studio |
| Missing information is clearly identified instead of silently invented | Absent values are `null` and listed in `missing` with a behaviour and a fix. Fallbacks are labelled. Readiness and `blockedBy` say whether it can go ahead. The brief tells the writer what not to invent. Tested on every field, and on a real recommendation before and after the gaps were filled |
