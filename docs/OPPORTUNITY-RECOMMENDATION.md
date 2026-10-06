# Opportunity → Recommendation

The foundation the Sprint 8 recommendation engine builds on. **It is not the
engine:** nothing here decides *what* to recommend. It fixes how a
recommendation is connected to the opportunity it answers, so the engine can
consume opportunities without the data model changing underneath it.

- An **opportunity** is something Aura noticed
  ([OPPORTUNITY-MODEL.md](OPPORTUNITY-MODEL.md)).
- A **recommendation** is what Aura proposes the business *do* about it.

> **Updated in Sprint 8:** the Recommendation model now holds the
> recommendation's own content (what, why, action, expected outcome, channel,
> audience), a full status lifecycle and history. Every recommendation must
> have an opportunity. See [RECOMMENDATION-MODEL.md](RECOMMENDATION-MODEL.md);
> this document covers the hand-off between the two.

| Piece | Where |
| --- | --- |
| Hand-off contract, eligibility, status sync (pure) | [`lib/recommendation-handoff.ts`](../lib/recommendation-handoff.ts) |
| Creating and deciding recommendations | [`server/recommendations/recommendation.service.ts`](../server/recommendations/recommendation.service.ts) |
| Schema | `Recommendation`, `RecommendationEvidence` in [`prisma/schema.prisma`](../prisma/schema.prisma); migration `20261005090000_recommendation_foundation` |
| Tests | [`tests/recommendation-handoff.test.ts`](../tests/recommendation-handoff.test.ts); `pnpm verify:recommendation-handoff` against a real database |

---

## 1. Relationship

```
Opportunity 1 ──── * Recommendation 1 ──── * RecommendationEvidence
     │                                              │
     └── OpportunitySignal ◄── opportunitySignalId ─┤
              │                                     │
              └── Signal ◄────────── signalId ──────┘
```

- **A recommendation references its originating opportunity** with
  `Recommendation.opportunityId`.
- **An opportunity can have several recommendations over time**, but only
  **one in play** (generated, presented, accepted, edited or in progress) at a time.
- **An opportunity never depends on a recommendation existing.** It is stored,
  reviewed and decided on its own.
- **Every recommendation has its opportunity.** The link is required, and an
  opportunity can't be deleted while it has recommendations. Deleting the
  whole workspace removes both. (Sprint 7 instead cleared the link; Sprint 8
  made it required.)

### Recommendation schema

See [RECOMMENDATION-MODEL.md](RECOMMENDATION-MODEL.md). What the hand-off
supplies to it: `opportunityId`, `confidence`, `confidenceReason`, `priority`,
`priorityScore`, `relevantUntil`, `handoff` and `handoffVersion`, the
`context…` fields, and a copy of every piece of evidence.

## 2. Data passed: the hand-off

`GET /api/opportunities/:id/handoff` returns `OpportunityHandoff` (version
`1`, validated by `opportunityHandoffSchema`):

| Part | Contents |
| --- | --- |
| `opportunity` | id, type, status, title, summary, rationale, angle, detector details (channels, content ideas, timing, rule criteria, AI reasoning), detected / last seen / relevant-until dates |
| `assessment` | confidence and its reason, priority and score, **impact and effort** |
| `evidence[]` | Every piece of evidence (section 4) |
| `context` | What business context the recommendation needs (section 3) |
| `provenance` | Source, what detected it, the rule id or the AI model and prompt version |

**Gap fixed:** impact and effort used to be calculated into priority and then
discarded, so a recommendation could not start from them. They are now stored
on the opportunity (`impact`, `effort`). For opportunities stored before this
change they are `null`, and the engine should treat them as unknown.

The hand-off is stored on the recommendation as it was at creation, so a
recommendation can always show what it was based on, even after the
opportunity changes.

## 3. Required context

| Field | Meaning |
| --- | --- |
| `snapshotView: "recommendation"` | The engine reads the business through `getContextSnapshot(companyId, { view: 'recommendation' })`, which has all sections. This is the same snapshot every AI workflow uses. |
| `fields` | The Business Context fields the opportunity relies on (e.g. `audience.stated`) |
| `shakyFields` | Of those, the ones that are **now** unconfirmed or out of date. The engine must not present a recommendation built on these as certain; it should ask the matching question first or say what it is assuming. |
| `revision`, `fingerprint` | The context the opportunity was detected against |
| `changedSinceDetection` | Whether the business context has changed since (null if not recorded) |

## 4. Evidence that carries forward

**All of it.** Each piece of the opportunity's evidence is **copied** into
`RecommendationEvidence` when the recommendation is created, rather than
shared, so later evidence changes on the opportunity don't silently change
what a recommendation was based on.

Each copy keeps:
- **Links:** `opportunitySignalId` to the opportunity's evidence row, and
  `signalId` to the normalised signal. Both are kept while they exist.
- **Content:** kind, record id, label, detail, URL and observed date.
- **Reliability:** the signal's reliability at hand-off time.

In the hand-off, each piece is also marked:
- **`current: false`** if its signal has expired or been pruned since detection
- **`supports`:** how the detector said it supports the opportunity (from AI
  detection)

## 5. Eligibility

An opportunity can become a recommendation only if:
- it is **open**: detected, reviewed, or already recommended
- its **relevance window hasn't passed**
- it has **at least one piece of current evidence**; a recommendation built
  only on expired signals would be recommending yesterday's opening
- it has **no other open recommendation**

The hand-off reports `eligibility: { eligible, reasons[] }`. Creating a
recommendation from an ineligible opportunity returns 409 with the reasons.

## 6. Keeping the two in step

One decision, recorded on both sides, in the same transaction:

| Event | Opportunity | Recommendation |
| --- | --- | --- |
| Recommendation created | → `RECOMMENDED` | `GENERATED` |
| Recommendation accepted | → `ACCEPTED` | `ACCEPTED` |
| Recommendation edited | → `ACCEPTED` | `EDITED` |
| Recommendation presented or skipped | unchanged | `PRESENTED` / `SKIPPED` |
| Recommendation rejected | → `REJECTED` | `REJECTED` |
| Recommendation withdrawn | unchanged; can be recommended again | `WITHDRAWN` |
| Opportunity accepted directly | `ACCEPTED` | open one → `ACCEPTED` |
| Opportunity rejected directly | `REJECTED` | open one → `REJECTED` |
| Opportunity expired | `EXPIRED` | open one → `EXPIRED` |

All opportunity moves still go through `transitionOpportunity`, so the
opportunity's history is complete. Decisions are compare-and-swap: a
recommendation is decided once; repeating the same decision is a no-op and a
different one gets a 409 (see [RECOMMENDATION-LIFECYCLE.md](RECOMMENDATION-LIFECYCLE.md)).

The **Recommend** button on the Opportunities page now creates a
recommendation (instead of only changing the status), so every recommended
opportunity has one.

## 7. API and interfaces

| Endpoint | Purpose | Who |
| --- | --- | --- |
| `GET /api/opportunities/:id/handoff` | The hand-off and its eligibility: **the engine's input** | Any member |
| `GET /api/opportunities/:id/recommendations` | Recommendations made from an opportunity | Any member |
| `POST /api/opportunities/:id/recommendations` `{ type?, title?, action?, … }` | Create one (201; 409 if ineligible or one is in play) | Owners and admins |
| `POST /api/recommendations/:id/decision` `{ decision, note? }` | `ACCEPTED`, `REJECTED` or `WITHDRAWN` (409 if already decided) | Owners and admins |
| `GET /api/opportunities/:id` | Now also lists its recommendations | Any member |

Service functions for the engine to call directly:
- `getOpportunityHandoff(companyId, opportunityId)`
- `createRecommendationFromOpportunity({ …, createdBy, content })`: the engine
  passes its own `createdBy` (model name) and `content` (what, why, action,
  expected outcome…), which replaces the default draft
- `decideRecommendation({ … })`
- `listRecommendations(companyId, { opportunityId })`

## Left for later

The recommendation's structure, lifecycle and execution brief are in
[RECOMMENDATION-MODEL.md](RECOMMENDATION-MODEL.md). Still to come:
- The engine: deciding what to recommend from the hand-off and the
  `recommendation` snapshot, and writing the content.
- A Recommendations page in the app.
- Choosing which opportunities to turn into recommendations automatically, and
  when.
