# Recommendation Data Model

A **recommendation** is what Aura proposes the business *do* about an
opportunity. It is stored on its own, always traces back to the opportunity it
answers, keeps the evidence it was based on, and moves through a tracked
lifecycle until it is done.

```
Recommendation
├── Opportunity        opportunityId (required)
├── What               title, summary
├── Why                rationale
├── Action             action, steps
├── Expected Outcome   expectedOutcome, outcomeMetric
├── Evidence           RecommendationEvidence (copied from the opportunity)
├── Confidence         confidence, confidenceReason
├── Priority           priority, priorityScore
├── Channel            channel, contentType
├── Audience           audience
└── Status             status + RecommendationEvent history
```

| Piece | Where |
| --- | --- |
| Rules: types, lifecycle, validation, default draft, execution brief (pure) | [`lib/recommendations.ts`](../lib/recommendations.ts) |
| What an opportunity hands over | [`lib/recommendation-handoff.ts`](../lib/recommendation-handoff.ts) ([OPPORTUNITY-RECOMMENDATION.md](OPPORTUNITY-RECOMMENDATION.md)) |
| Service | [`server/recommendations/recommendation.service.ts`](../server/recommendations/recommendation.service.ts) |
| Schema | `Recommendation`, `RecommendationEvidence`, `RecommendationEvent` in [`prisma/schema.prisma`](../prisma/schema.prisma); migration `20261006090000_recommendation_model` |
| Tests | [`tests/recommendations.test.ts`](../tests/recommendations.test.ts); `pnpm verify:recommendations` against a real database |

---

## 1. Schema

| Field | Part | Notes |
| --- | --- | --- |
| `opportunityId` | Opportunity | **Required.** The database refuses a recommendation without one, and an opportunity can't be deleted while it has recommendations (deleting the whole workspace removes both). |
| `type` | Category | See section 2 |
| `title`, `summary` | What | |
| `action`, `steps[]` | Action | One imperative sentence; up to 8 steps |
| `rationale` | Why | Why this is worth doing now, from the evidence |
| `expectedOutcome`, `outcomeMetric` | Expected outcome | What should change if it works, and the measure (e.g. `engagement`) |
| `RecommendationEvidence` | Evidence | Copied from the opportunity, linked to its evidence row and the signal |
| `confidence`, `confidenceReason` | Confidence | Inherited from the opportunity; may be lowered, never raised |
| `priority`, `priorityScore` | Priority | Inherited from the opportunity |
| `channel`, `contentType` | Channel | One of Aura's channels (LinkedIn, Blog, Newsletter, X, Instagram, YouTube), and the content format for content recommendations. Null where it doesn't apply. |
| `audience` | Audience | Who it is for. Null where it doesn't apply (e.g. connecting a channel). |
| `status` + `RecommendationEvent` | Status | Section 3 |
| `relevantUntil` | Relevance | Not worth starting after this. Defaults to the opportunity's window; may be shorter, never longer. |
| `contextRevision`, `contextFingerprint`, `contextFields` | Business Context | The context it was built against, and the facts it relies on |
| `handoff`, `handoffVersion` | Provenance | The exact opportunity hand-off it was built from |
| `details` | | Type-specific detail for the workflow (content ideas, angle, timing) |
| `createdBy` | | `user:<id>`, `rule:…`, or a model name |
| `createdAt`, `updatedAt`, `statusChangedAt`, `decidedAt`, `startedAt`, `completedAt`, `expiredAt` | Timestamps | |

## 2. Types

| Type | Comes from (opportunity type) | Carried out in |
| --- | --- | --- |
| `CONTENT` | Trending topic, content gap, seasonal moment | Content Studio |
| `CAMPAIGN` | Chosen by a person or the engine | Content plan |
| `COMPETITIVE_RESPONSE` | Competitor move, competitive gap | Content Studio |
| `AUDIENCE` | Audience segment | Content Studio |
| `CHANNEL` | Channel | Connectors |
| `OPTIMIZATION` | What is working (performance pattern) | Content plan |
| `OTHER` | Other | Content plan |

## 3. Status

```
PROPOSED ─► ACCEPTED ─► IN_PROGRESS ─► COMPLETED
   │           └─────────────────────► COMPLETED
   ├─► REJECTED
   ├─► WITHDRAWN    (also from ACCEPTED / IN_PROGRESS: taken back)
   └─► EXPIRED      (relevance window passed before a decision)
```

- **Final states:** completed, rejected, withdrawn and expired are final. A new
  recommendation is made instead, so each one's history stays what it was.
- **One at a time:** an opportunity can have only one recommendation in play
  (proposed, accepted or in progress).
- **Compare-and-swap:** each status change is decided once, and recorded in
  `RecommendationEvent` with who, when and why.
- **Expiry:** only a recommendation still waiting for a decision expires.
  Accepted and in-progress ones are commitments, so they don't.

**Kept in step with the opportunity**, in the same transaction:

| Recommendation | Opportunity |
| --- | --- |
| created | → Recommended |
| accepted | → Accepted |
| rejected | → Rejected |
| in progress, completed | unchanged (already Accepted) |
| withdrawn, expired | unchanged (can be recommended again) |

| Opportunity | Its open recommendation |
| --- | --- |
| accepted directly | → Accepted |
| rejected directly | → Rejected |
| expired | → Expired |

## 4. Creating one

`createRecommendationFromOpportunity` builds a complete recommendation:
1. **Inherited from the opportunity's hand-off:** the link, confidence,
   priority, relevance, business context and a copy of the evidence.
2. **Content (what, why, action…):** starts as the **default draft**
   (`draftFromOpportunity`), built with plain templates from the opportunity's
   reasoning, angle and content ideas, the channel it or the business names,
   and the business's stated audience.
3. **Overrides:** any field the caller supplies replaces the draft's. That
   caller is a person, or the recommendation engine when it is built.
4. **Validation:** the result is validated as a whole. Confidence and
   relevance are bounded by the opportunity.

So a recommendation is always structured and actionable.

The **recommendation engine**
([RECOMMENDATION-ENGINE.md](RECOMMENDATION-ENGINE.md)) is now how
recommendations are normally created. It chooses the action that fits the
current business, writes it, assesses it and checks it is supported, then
stores it through this same function.

## 5. Handing over to Content / Execution workflows

`executionBrief(recommendation)`, returned as `execution` by
`GET /api/recommendations/:id`, is the contract for the execution sprints:

| Field | Meaning |
| --- | --- |
| `workflow` | `CONTENT`, `PLANNER`, `CONNECTORS`, `COMPETITORS` or `BUSINESS_PROFILE` |
| `href` | Where to carry it out. For content, Content Studio opens with the brief pre-filled. |
| `brief` | Title, action, steps, angle, audience, why and goal, as one text |
| `channel`, `contentType`, `audience` | For the generator |
| `dueBy` | The recommendation's relevance date |
| `evidence` | What it is based on, so the output can cite it |
| `recommendationId`, `opportunityId` | So results can be traced back |

## 6. API

| Endpoint | Purpose | Who |
| --- | --- | --- |
| `GET /api/recommendations?status=&opportunityId=` | List, newest first; undecided ones past their window are expired first | Any member |
| `GET /api/recommendations/:id` | One recommendation, with evidence, history, opportunity and `execution` | Any member |
| `POST /api/opportunities/:id/recommendations` `{ type?, title?, action?, … }` | Create from an opportunity; fields replace the draft's | Owners and admins |
| `POST /api/recommendations/:id/status` `{ status, note? }` | Accept, reject, withdraw, start, complete | Owners and admins |
| `POST /api/recommendations/:id/decision` | Accept, reject or withdraw (kept from Sprint 7) | Owners and admins |

All of these are covered by the data-access security guard
([DATA-ACCESS-SECURITY.md](DATA-ACCESS-SECURITY.md)).

## 7. Migration

`20261006090000_recommendation_model` is safe for recommendations that already
exist:
- **It stops** with a clear message if any recommendation has no opportunity.
- **It fills** the new required fields from each recommendation's opportunity:
  type, action, why, and relevance. The expected outcome is marked "not
  recorded".
- **It carries over** the old `content` field into `details`.
- **It adds** a first history entry for each recommendation.
